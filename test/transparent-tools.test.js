import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { installTransparentToolOverrides, mirrorPathForRemote } from '../lib/transparent-tools.js'

const TOOL_NAMES = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash']
const UNSUPPORTED_TOOLS = ['read_image', 'glob', 'grep']
const READ_VERSION = 'a'.repeat(64)
const WRITE_VERSION = 'b'.repeat(64)
const EDIT_VERSION = 'c'.repeat(64)

function makeTool(name, localCalls) {
  return {
    name,
    description: `${name} description`,
    parameters: name === 'bash'
      ? {
        type: 'object',
        required: ['description', 'command'],
        properties: {
          description: { type: 'string' },
          command: { type: 'string' },
          timeoutMs: { type: 'number' },
          workdir: { type: 'string' },
          run_in_background: { type: 'boolean' },
          sandbox_permissions: { type: 'string' },
          justification: { type: 'string' },
        },
      }
      : { type: 'object', properties: { file_path: { type: 'string' } } },
    output: {
      schema: name === 'bash'
        ? { type: 'object', additionalProperties: true }
        : { type: 'object', additionalProperties: false },
      render: () => [{ type: 'text', text: name }],
      presentationMeta: () => ({ tool: name }),
    },
    presentCall: () => ({ title: name }),
    presentResult: () => ({ title: name }),
    isConcurrencySafe: () => true,
    localMarker: { name },
    async execute() {
      localCalls[name] += 1
      return { local: true }
    },
  }
}

function createFixture(t, options = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-transparent-tools-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const mirrorDir = path.join(temp, 'mirror')
  mkdirSync(path.join(mirrorDir, 'src'), { recursive: true })

  const localCalls = Object.fromEntries(TOOL_NAMES.map((name) => [name, 0]))
  const globalTools = new Map(TOOL_NAMES.map((name) => [name, makeTool(name, localCalls)]))
  const scopedTools = new Map()
  const registry = {
    get(name) { return scopedTools.get(name) ?? globalTools.get(name) },
    register(tool) {
      scopedTools.set(tool.name, tool)
      return () => scopedTools.delete(tool.name)
    },
  }
  const agent = { ctx: { tools: registry }, session: { header: { cwd: path.join(mirrorDir, 'src') } } }
  const exec = { agent, signal: new AbortController().signal }
  const binding = options.binding === undefined
    ? { ws: '/srv/project', mirrorDir }
    : (options.binding ? { ...options.binding, mirrorDir: options.binding.mirrorDir ?? mirrorDir } : null)
  const requests = []
  const order = []
  const rpc = {
    async request(op, payload, requestOptions) {
      requests.push({ op, payload, requestOptions })
      order.push(`rpc:${op}`)
      if (options.request) return options.request(op, payload, requestOptions)
      if (op === 'read') return {
        path: payload.path,
        offset: payload.offset ?? 1,
        lines: [{ number: 1, text: 'remote' }],
        totalLines: 1,
        truncatedByBytes: false,
        version: READ_VERSION,
      }
      if (op === 'write') return {
        path: payload.path,
        operation: 'update',
        before: 'old',
        after: payload.content,
        version: WRITE_VERSION,
        internal: 'discard me',
      }
      return {
        path: payload.path,
        before: payload.oldString,
        after: payload.newString,
        version: EDIT_VERSION,
        internal: 'discard me',
      }
    },
  }
  const helper = options.helper === undefined ? { root: options.helperRoot, rpc } : options.helper
  const guardCalls = []
  const targets = []
  const intents = []
  const observations = []

  const dispose = installTransparentToolOverrides({
    agent,
    resolveBinding: options.resolveBinding || (async () => binding),
    resolveWorkingDirectory: options.resolveWorkingDirectory || (async (toolExec) => toolExec.agent.session.header.cwd),
    resolveFsTarget: options.resolveFsTarget || (async (remotePath) => {
      const target = { path: remotePath }
      targets.push(target)
      return target
    }),
    runFsIntent: options.runFsIntent || (async (...args) => {
      intents.push(args)
      return options.intent
    }),
    emitFsObserved: options.emitFsObserved || ((...args) => observations.push(args)),
    getHelper: options.getHelper || (async () => helper),
    readImage: options.readImage,
    resolveBashSpec: options.resolveBashSpec,
    executeBash: options.executeBash,
    onRemoteMutation: options.onRemoteMutation,
    readOpaqueResource: options.readOpaqueResource,
    beforeRemoteFileAccess: options.beforeRemoteFileAccess || (async (context) => {
      order.push(`before:${context.name}`)
    }),
    isSearchToolWrapped: options.isSearchToolWrapped,
    assertMutationAllowed: options.assertMutationAllowed || (async (...args) => { guardCalls.push(args) }),
  })

  return { agent, binding, dispose, exec, globalTools, guardCalls, helper, intents, localCalls, mirrorDir, observations, order, requests, scopedTools, targets }
}

test('registers same-name scoped overrides while preserving standard tool metadata', (t) => {
  const fixture = createFixture(t)
  assert.deepEqual([...fixture.scopedTools.keys()], TOOL_NAMES)

  for (const name of TOOL_NAMES) {
    const original = fixture.globalTools.get(name)
    const scoped = fixture.scopedTools.get(name)
    assert.equal(scoped.name, name)
    assert.notEqual(scoped.execute, original.execute)
    for (const field of ['description', 'parameters', 'output', 'presentCall', 'presentResult', 'localMarker']) {
      assert.strictEqual(scoped[field], original[field], `${name}.${field} should be preserved by reference`)
    }
    if (name === 'read_image') assert.equal(scoped.isConcurrencySafe(), false)
    else assert.strictEqual(scoped.isConcurrencySafe, original.isConcurrencySafe)
    assert.strictEqual(fixture.agent.ctx.tools.get(name), scoped)
  }
})

test('keeps bridged native search tools unshadowed while other unsupported tools fail closed', async (t) => {
  const fixture = createFixture(t, {
    isSearchToolWrapped: (name, visible) => ['glob', 'grep'].includes(name) && visible?.name === name,
  })
  assert.equal(fixture.scopedTools.has('glob'), false)
  assert.equal(fixture.scopedTools.has('grep'), false)
  assert.equal(fixture.scopedTools.get('bash').name, 'bash')
  await assert.rejects(fixture.scopedTools.get('bash').execute({ command: 'pwd' }, fixture.exec), /not supported in transparent remote mode/)
})

test('pre-file instruction refresh runs before the remote read and remains core-owned', async (t) => {
  const fixture = createFixture(t, {
    beforeRemoteFileAccess: async ({ name, remotePath, binding, helper }) => {
      assert.equal(name, 'read')
      assert.equal(remotePath, '/srv/project/src/notes.txt')
      assert.equal(binding.ws, '/srv/project')
      assert.equal(helper, fixture.helper)
      fixture.order.push('instruction-refresh')
    },
  })
  await fixture.scopedTools.get('read').execute({ file_path: 'notes.txt' }, fixture.exec)
  assert.deepEqual(fixture.order, ['instruction-refresh', 'rpc:read'])
})
test('read translates mirror paths, forwards cancellation, and returns only schema fields', async (t) => {
  const fixture = createFixture(t)
  const signal = new AbortController().signal
  fixture.exec.signal = signal
  const result = await fixture.scopedTools.get('read').execute({
    file_path: path.join(fixture.mirrorDir, 'src', 'notes.txt'),
    offset: 4,
    limit: 3,
  }, fixture.exec)

  assert.deepEqual(fixture.requests[0], {
    op: 'read',
    payload: { path: '/srv/project/src/notes.txt', offset: 4, limit: 3 },
    requestOptions: { signal },
  })
  assert.deepEqual(result, {
    path: '/srv/project/src/notes.txt',
    offset: 4,
    lines: [{ number: 1, text: 'remote' }],
    totalLines: 1,
  })
  assert.deepEqual(Object.keys(result), ['path', 'offset', 'lines', 'totalLines'])
  assert.deepEqual(fixture.observations, [[
    fixture.targets[1],
    { kind: 'present', version: READ_VERSION },
    fixture.exec,
  ]])
  assert.equal(fixture.localCalls.read, 0)
})

test('a read through a symlink can be edited through its canonical path', async (t) => {
  const canonicalPath = '/srv/project/src/target.txt'
  const fixture = createFixture(t, {
    request: async (op, payload) => op === 'read'
      ? { path: canonicalPath, offset: 1, lines: [{ number: 1, text: 'before' }], totalLines: 1, version: READ_VERSION }
      : { path: canonicalPath, before: 'before', after: 'after', version: EDIT_VERSION },
  })

  await fixture.scopedTools.get('read').execute({ file_path: '/srv/project/src/alias.txt' }, fixture.exec)
  await fixture.scopedTools.get('edit').execute({
    file_path: canonicalPath,
    old_string: 'before',
    new_string: 'after',
  }, fixture.exec)
  await fixture.scopedTools.get('edit').execute({
    file_path: '/srv/project/src/alias.txt',
    old_string: 'after',
    new_string: 'again',
  }, fixture.exec)

  assert.equal(fixture.requests[1].payload.expectedVersion, READ_VERSION)
  assert.equal(fixture.requests[1].payload.expectedPath, canonicalPath)
  assert.equal(fixture.requests[2].payload.expectedVersion, EDIT_VERSION)
  assert.equal(fixture.requests[2].payload.expectedPath, canonicalPath)
  assert.equal(fixture.intents[0][1].path, canonicalPath)
})
test('a missing remote read emits an absent observation', async (t) => {
  const fixture = createFixture(t, {
    request: async () => {
      const error = new Error('cannot resolve remote path: ENOENT')
      error.code = 'ENOENT'
      throw error
    },
  })
  await assert.rejects(fixture.scopedTools.get('read').execute({ file_path: 'missing.txt' }, fixture.exec), /ENOENT/)
  assert.deepEqual(fixture.observations, [[fixture.targets[0], { kind: 'absent' }, fixture.exec]])
})

test('read_image uses its remote bridge and emits a canonical observation', async (t) => {
  const canonicalPath = '/srv/project/src/diagram.png'
  let received
  const fixture = createFixture(t, {
    readImage: async (input) => {
      received = input
      return {
        path: canonicalPath,
        version: READ_VERSION,
        image: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 16, width: 2, height: 2 },
        internal: 'discard me',
      }
    },
  })

  const result = await fixture.scopedTools.get('read_image').execute({ file_path: 'diagram.png' }, fixture.exec)

  assert.deepEqual(Object.keys(result), ['path', 'image'])
  assert.equal(result.path, canonicalPath)
  assert.equal(received.remotePath, '/srv/project/src/diagram.png')
  assert.equal(fixture.scopedTools.get('read_image').isConcurrencySafe(), false)
  assert.equal(fixture.globalTools.get('read_image').isConcurrencySafe(), true)
  assert.deepEqual(fixture.observations.map(([, observation]) => observation), [
    { kind: 'present', version: READ_VERSION },
  ])
  assert.equal(fixture.localCalls.read_image, 0)
})
test('read accepts remote absolute paths and maps relative paths from the session cwd', async (t) => {
  const fixture = createFixture(t)
  const read = fixture.scopedTools.get('read').execute

  await read({ file_path: '/srv/project/docs/guide.md' }, fixture.exec)
  await read({ file_path: '../README.md' }, fixture.exec)

  assert.deepEqual(fixture.requests.map(({ payload }) => payload.path), [
    '/srv/project/docs/guide.md',
    '/srv/project/README.md',
  ])
})

test('read rejects absolute paths outside either root and relative traversal', async (t) => {
  const fixture = createFixture(t)
  const read = fixture.scopedTools.get('read').execute
  const outside = path.join(path.dirname(fixture.mirrorDir), 'outside.txt')

  await assert.rejects(read({ file_path: outside }, fixture.exec), /absolute path is outside/)
  await assert.rejects(read({ file_path: '/etc/passwd' }, fixture.exec), /absolute path is outside/)
  await assert.rejects(read({ file_path: '../../../etc/passwd' }, fixture.exec), /outside the remote workspace/)
  assert.equal(fixture.requests.length, 0)
})

test('workspace symlink aliases normalize to the negotiated helper root', async (t) => {
  const fixture = createFixture(t, {
    binding: { ws: '/srv/project-link' },
    helperRoot: '/srv/real/project',
  })
  const read = fixture.scopedTools.get('read').execute

  await read({ file_path: '/srv/project-link/src/a.js' }, fixture.exec)
  await read({ file_path: '/srv/real/project/src/b.js' }, fixture.exec)
  await read({ file_path: path.join(fixture.mirrorDir, 'src', 'c.js') }, fixture.exec)

  assert.deepEqual(fixture.requests.map(({ payload }) => payload.path), [
    '/srv/real/project/src/a.js',
    '/srv/real/project/src/b.js',
    '/srv/real/project/src/c.js',
  ])
})
test('remote canonical paths map into the mirror and stay root-confined', (t) => {
  const fixture = createFixture(t)
  assert.throws(() => mirrorPathForRemote(fixture.binding, '/srv/other/file.js'), /outside the workspace/)
  assert.throws(() => mirrorPathForRemote(fixture.binding, 'relative/file.js'), /absolute POSIX path/)
})

test('relative paths use the current DSH working directory on every invocation', async (t) => {
  let cwd
  const fixture = createFixture(t, { resolveWorkingDirectory: async () => cwd })
  cwd = path.join(fixture.mirrorDir, 'docs')

  await fixture.scopedTools.get('read').execute({ file_path: 'guide.md' }, fixture.exec)

  assert.equal(fixture.requests[0].payload.path, '/srv/project/docs/guide.md')
})

test('disposing removes scoped definitions without changing global tools', (t) => {
  const fixture = createFixture(t)
  fixture.dispose()

  assert.equal(fixture.scopedTools.size, 0)
  assert.equal(fixture.agent.ctx.tools.get('read'), fixture.globalTools.get('read'))
})
test('read rejects a session cwd outside the remote binding', async (t) => {
  const fixture = createFixture(t)
  fixture.exec.agent.session.header.cwd = path.dirname(fixture.mirrorDir)

  await assert.rejects(fixture.scopedTools.get('read').execute({ file_path: 'notes.txt' }, fixture.exec), /session cwd is outside/)
  assert.equal(fixture.requests.length, 0)
})

test('write and edit call mutation guard and preserve their standard result fields', async (t) => {
  const fixture = createFixture(t)
  const writeArgs = { file_path: path.join(fixture.mirrorDir, 'src', 'file.txt'), content: 'new' }
  const editArgs = { file_path: 'file.txt', old_string: 'old', new_string: 'new', replace_all: true }

  await fixture.scopedTools.get('read').execute({ file_path: writeArgs.file_path }, fixture.exec)
  const writeResult = await fixture.scopedTools.get('write').execute(writeArgs, fixture.exec)
  const editResult = await fixture.scopedTools.get('edit').execute(editArgs, fixture.exec)

  assert.deepEqual(fixture.requests.map(({ op, payload }) => ({ op, payload })), [
    { op: 'read', payload: { path: '/srv/project/src/file.txt', offset: undefined, limit: undefined } },
    { op: 'write', payload: { path: '/srv/project/src/file.txt', content: 'new', expectedVersion: READ_VERSION, expectedPath: '/srv/project/src/file.txt' } },
    { op: 'edit', payload: { path: '/srv/project/src/file.txt', oldString: 'old', newString: 'new', replaceAll: true, expectedVersion: WRITE_VERSION, expectedPath: '/srv/project/src/file.txt' } },
  ])
  assert.deepEqual(writeResult, { path: '/srv/project/src/file.txt', operation: 'update', before: 'old', after: 'new' })
  assert.deepEqual(editResult, { path: '/srv/project/src/file.txt', before: 'old', after: 'new' })
  assert.deepEqual(fixture.guardCalls, [
    [fixture.exec, writeArgs, 'write'],
    [fixture.exec, editArgs, 'edit'],
  ])
  assert.deepEqual(fixture.intents.map(([name]) => name), ['fs/write-intent', 'fs/edit-intent'])
  assert.deepEqual(fixture.observations.map(([, observation]) => observation), [
    { kind: 'present', version: READ_VERSION },
    { kind: 'present', version: WRITE_VERSION },
    { kind: 'present', version: EDIT_VERSION },
  ])
  assert.equal(fixture.localCalls.write, 0)
  assert.equal(fixture.localCalls.edit, 0)
})

test('write awaits post-mutation mirror refresh before returning to DSH', async (t) => {
  let refreshed = false
  const fixture = createFixture(t, {
    onRemoteMutation: async ({ name, remotePath }) => {
      assert.equal(name, 'write')
      assert.equal(remotePath, '/srv/project/src/new-rules.txt')
      await new Promise((resolve) => setImmediate(resolve))
      refreshed = true
    },
  })
  await fixture.scopedTools.get('write').execute({ file_path: 'new-rules.txt', content: 'rules' }, fixture.exec)
  assert.equal(refreshed, true)
})
test('non-empty DSH mutation intents fail closed before remote writes', async (t) => {
  const fixture = createFixture(t, { intent: { kind: 'unrecognized-policy' } })
  const edit = fixture.scopedTools.get('edit').execute
  const filePath = path.join(fixture.mirrorDir, 'src', 'file.txt')

  await fixture.scopedTools.get('read').execute({ file_path: filePath }, fixture.exec)
  await assert.rejects(edit({ file_path: filePath, old_string: 'old', new_string: 'new' }, fixture.exec), /cannot honor a non-empty local filesystem intent/)

  assert.deepEqual(fixture.requests.map(({ op }) => op), ['read'])
  assert.deepEqual(fixture.intents.map(([name]) => name), ['fs/edit-intent'])
})

test('write and edit reject sandbox escalation arguments and denied mutations', async (t) => {
  let allowed = true
  const fixtureGuardCalls = []
  const fixture = createFixture(t, {
    assertMutationAllowed: async (...args) => {
      fixtureGuardCalls.push(args)
      return allowed
    },
  })
  const write = fixture.scopedTools.get('write').execute
  const edit = fixture.scopedTools.get('edit').execute
  const validArgs = { file_path: 'notes.txt', content: 'new' }
  const validEditArgs = { file_path: 'notes.txt', old_string: 'old', new_string: 'new' }

  await assert.rejects(write({ ...validArgs, sandbox_permissions: 'danger-full-access' }, fixture.exec), /does not accept sandbox_permissions or justification/)
  await assert.rejects(write({ ...validArgs, justification: 'needed' }, fixture.exec), /does not accept sandbox_permissions or justification/)
  await assert.rejects(edit({ ...validEditArgs, sandbox_permissions: 'danger-full-access' }, fixture.exec), /does not accept sandbox_permissions or justification/)
  await assert.rejects(edit({ ...validEditArgs, justification: 'needed' }, fixture.exec), /does not accept sandbox_permissions or justification/)
  assert.equal(fixtureGuardCalls.length, 0)

  allowed = false
  await assert.rejects(write(validArgs, fixture.exec), /is not authorized/)
  assert.equal(fixtureGuardCalls.length, 1)
  assert.equal(fixture.requests.length, 0)
  assert.equal(fixture.localCalls.write, 0)
  assert.equal(fixture.localCalls.edit, 0)
})

test('supported operations fail closed when the binding or RPC helper is unavailable', async (t) => {
  const missingBinding = createFixture(t, { binding: null })
  await assert.rejects(missingBinding.scopedTools.get('read').execute({ file_path: 'notes.txt' }, missingBinding.exec), /binding is unavailable/)

  const missingHelper = createFixture(t, { helper: null })
  await assert.rejects(missingHelper.scopedTools.get('read').execute({ file_path: 'notes.txt' }, missingHelper.exec), /helper is unavailable/)
  assert.equal(missingBinding.localCalls.read, 0)
  assert.equal(missingHelper.localCalls.read, 0)
})

test('remote Bash preserves DSH foreground results and rejects background/escalation', async (t) => {
  let fixture
  const calls = []
  fixture = createFixture(t, {
    resolveBashSpec: async (args, exec) => ({
      spec: {
        command: args.command,
        workdir: exec.agent.session.header.cwd,
        timeoutMs: args.timeoutMs ?? 2000,
        onExpiry: 'kill',
        stdoutMaxBytes: 64000,
        sandboxPolicy: { mode: 'workspace-write', workspaceRoot: path.dirname(exec.agent.session.header.cwd) },
      },
    }),
    executeBash: async (context) => {
      calls.push(context)
      return {
        kind: 'foreground',
        cwd: '/srv/project/src',
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 2000,
        stdout: { text: 'remote\\n', truncated: false },
        stderr: { text: '', truncated: false },
        sandbox: { mode: 'workspace-write', denied: false, enforcement: 'full' },
      }
    },
  })
  const bash = fixture.scopedTools.get('bash')
  const result = await bash.execute({ description: 'Print remote directory', command: 'pwd' }, fixture.exec)

  assert.equal(bash.parameters.properties.run_in_background, undefined)
  assert.equal(bash.parameters.properties.sandbox_permissions, undefined)
  assert.match(bash.description, /foreground-only/)
  assert.equal(result.kind, 'foreground')
  assert.equal(result.cwd, '/srv/project/src')
  assert.equal(result.stdout.text, 'remote\\n')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].binding.ws, '/srv/project')
  assert.equal(calls[0].prepared.spec.command, 'pwd')
  assert.equal(fixture.localCalls.bash, 0)

  await assert.rejects(bash.execute({ description: 'Background command', command: 'sleep 1', run_in_background: true }, fixture.exec), /foreground-only/)
  await assert.rejects(bash.execute({ description: 'Escalated command', command: 'id', sandbox_permissions: 'danger-full-access', justification: 'needed' }, fixture.exec), /sandbox_permissions or justification/)
  assert.equal(calls.length, 1)
  assert.equal(fixture.localCalls.bash, 0)
})


test('remote Bash marks project skills dirty after any command outcome', async (t) => {
  const mutations = []
  let fail = false
  const fixture = createFixture(t, {
    resolveBashSpec: async () => ({ spec: { command: 'true', workdir: '/srv/project', timeoutMs: 1000 } }),
    executeBash: async () => {
      if (fail) throw new Error('remote command failed after possible file writes')
      return { kind: 'foreground', exitCode: 0 }
    },
    onRemoteMutation: (event) => mutations.push(event),
  })
  const bash = fixture.scopedTools.get('bash')
  await bash.execute({ description: 'Run remote command', command: 'true' }, fixture.exec)
  fail = true
  await assert.rejects(bash.execute({ description: 'May have changed a skill', command: 'false' }, fixture.exec), /remote command failed/)
  assert.equal(mutations.length, 2)
  assert.deepEqual(mutations.map(({ name }) => name), ['bash', 'bash'])
})


test('unsupported tools fail closed without invoking their global local implementations', async (t) => {
  const fixture = createFixture(t)
  for (const name of UNSUPPORTED_TOOLS) {
    await assert.rejects(fixture.scopedTools.get(name).execute({ file_path: 'notes.txt' }, fixture.exec), /not supported in transparent remote mode/)
    assert.equal(fixture.localCalls[name], 0, `${name} must not fall back to local execute`)
  }
  assert.equal(fixture.requests.length, 0)
})

test('read serves remote skill resources outside the workspace without mirror or instruction work', async (t) => {
  const calls = []
  const fixture = createFixture(t, {
    readOpaqueResource: async (args, exec) => {
      calls.push({ args, agent: exec.agent })
      if (args.file_path !== '/Users/someone/.dsh/skills/pdf/SKILL.md') return undefined
      return { path: args.file_path, offset: 1, lines: [{ number: 1, text: '# pdf' }], totalLines: 1 }
    },
  })
  const result = await fixture.scopedTools.get('read').execute({ file_path: '/Users/someone/.dsh/skills/pdf/SKILL.md' }, fixture.exec)
  assert.deepEqual(result, { path: '/Users/someone/.dsh/skills/pdf/SKILL.md', offset: 1, lines: [{ number: 1, text: '# pdf' }], totalLines: 1 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agent, fixture.agent)
  assert.deepEqual(fixture.requests, [], 'opaque skill reads must not use the workspace RPC')
  assert.deepEqual(fixture.order, [], 'opaque skill reads must skip instruction refresh and mirror mapping')
  assert.equal(fixture.localCalls.read, 0, 'the local read tool must never run')
})

test('read falls through to the workspace path when no opaque resource matches', async (t) => {
  const fixture = createFixture(t, { readOpaqueResource: async () => undefined })
  const result = await fixture.scopedTools.get('read').execute({ file_path: 'notes.txt' }, fixture.exec)
  assert.deepEqual(result.lines, [{ number: 1, text: 'remote' }])
  assert.equal(fixture.requests[0].op, 'read')
  assert.deepEqual(fixture.order, ['before:read', 'rpc:read'])
})

test('write and edit never consult opaque skill resources', async (t) => {
  let consulted = 0
  const fixture = createFixture(t, { readOpaqueResource: async () => { consulted += 1; return undefined } })
  await fixture.scopedTools.get('read').execute({ file_path: 'notes.txt' }, fixture.exec)
  const edited = await fixture.scopedTools.get('edit').execute({ file_path: 'notes.txt', old_string: 'a', new_string: 'b' }, fixture.exec)
  assert.equal(edited.before, 'a', 'a workspace edit still works after the opaque probe declines')
  assert.equal(consulted, 1, 'only read may consult remote skill resources')
})
