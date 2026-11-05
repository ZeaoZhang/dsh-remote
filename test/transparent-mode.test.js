import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-transparent-mode-'))
  const root = path.join(home, 'remote-workspaces')
  const mirrorDir = path.join(root, '127.0.0.11-lucas-1', 'proj')
  mkdirSync(mirrorDir, { recursive: true })
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({
    list: [{ id: 'm-linux', name: 'linuxbox', host: '127.0.0.11', port: 1, username: 'lucas', password: 'pw' }],
    currentId: 'm-linux',
  }))
  writeFileSync(path.join(mirrorDir, '.dsh-remote-meta.json'), JSON.stringify({
    host: '127.0.0.11', port: 1, username: 'lucas', remotePath: '/home/lucas/proj',
  }))
  return { home, mirrorDir }
}

function standardTool(name, calls) {
  return {
    name,
    description: `global ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    async execute() { calls[name] = (calls[name] || 0) + 1; return { local: true } },
  }
}

function makeCtx(names = [], skillsService) {
  const tools = new Map()
  const calls = {}
  for (const name of names) tools.set(name, standardTool(name, calls))
  const listeners = new Map()
  const ctx = {
    effect: () => {},
    inject: () => {},
    get: (name) => name === 'skills' ? skillsService : undefined,
    on: (event, fn) => { listeners.set(event, fn); return () => listeners.delete(event) },
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    systemPrompt: { section: () => {} },
  }
  return { calls, ctx, listeners, tools }
}

function agentFor(cwd, globalTools, skillsService) {
  const scoped = new Map()
  const denied = new Set()
  const skillProviders = new Map()
  const scopedSkills = {
    registerProvider(create) {
      const provider = create({ signal: new AbortController().signal, invalidate() {} })
      skillProviders.set(provider.name, provider)
      return () => skillProviders.delete(provider.name)
    },
  }
  const agent = {
    session: { header: { cwd } },
    ctx: {
      get(name) { return name === 'skills' ? scopedSkills : undefined },
      get skills() { throw new Error('cannot get property "skills" without inject') },
      tools: {
        get(name, scope) {
          if (scope === agent) return scoped.get(name) ?? (denied.has(name) ? undefined : globalTools.get(name))
          return globalTools.get(name)
        },
        register(tool) {
          if (scoped.has(tool.name)) throw new Error(`duplicate scoped tool ${tool.name}`)
          scoped.set(tool.name, tool)
          return () => scoped.delete(tool.name)
        },
        restrict({ deny: names }) {
          const unknown = names.filter((name) => !globalTools.has(name))
          if (unknown.length) throw new Error(`tools.restrict() names unknown global tools ${unknown.join(', ')}`)
          assert.ok(names.length > 0, 'skip restrictions when no legacy tools are registered')
          for (const name of names) denied.add(name)
          return () => { for (const name of names) denied.delete(name) }
        },
      },
    },
  }
  return { agent, denied, scoped, skillProviders }
}

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1200,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
  localTools: 'bootstrap', executionMode: 'transparent',
}

test('pre-step refresh warnings never abort a remote session', async (t) => {
  const { home, mirrorDir } = makeHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })
  const mod = await import(`../lib/index.js?pre-step-warning=${Math.random()}`)
  for (const loggerMode of ['available', 'missing', 'throwing']) {
    const fixture = makeCtx(['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash'])
    const warnings = []
    fixture.ctx.get = (name) => {
      if (name !== 'logger' || loggerMode === 'missing') return undefined
      return { warn(...args) {
        if (loggerMode === 'throwing') throw new Error('logger unavailable')
        warnings.push(args)
      } }
    }
    await mod.apply(fixture.ctx, { ...CONFIG })
    const remote = agentFor(mirrorDir, fixture.tools)
    await fixture.listeners.get('agent/created')({ agent: remote.agent })
    let continued = 0
    const result = await fixture.listeners.get('agent/pre-step')({ agent: remote.agent }, async () => {
      continued++
      return 'continued'
    })
    assert.equal(result, 'continued')
    assert.equal(continued, 1)
    if (loggerMode === 'available') {
      // A fixture with no subprocess service also reports the degraded search
      // bridge; only the instruction-refresh diagnostic belongs here.
      const refreshWarnings = warnings.filter((args) => /remote instruction pre-step refresh failed/.test(String(args[0])))
      assert.equal(refreshWarnings.length, 1)
      assert.match(refreshWarnings[0][1], /requires DSH workingDirectory.ensure/)
    }
    await fixture.listeners.get('agent/disposed')({ agent: remote.agent })
  }
})

test('pre-step refresh resolves the sandbox policy shared with agent creation', async (t) => {
  const { home, mirrorDir } = makeHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })
  const { RemoteHelperBroker } = await import('../lib/remote-helper.js')
  t.mock.method(RemoteHelperBroker.prototype, 'get', async () => ({ root: '/home/lucas/proj' }))
  const fixture = makeCtx(['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash'])
  const warnings = []
  const policyInputs = []
  fixture.ctx.get = (name) => ({
    workingDirectory: { ensure: async () => path.join(home, 'outside-mirror') },
    sandboxPolicy: { resolve: async (input) => { policyInputs.push(input); return { mode: 'danger-full-access' } } },
    logger: { warn: (...args) => warnings.push(args) },
  })[name]
  const mod = await import(`../lib/index.js?pre-step-policy=${Math.random()}`)
  await mod.apply(fixture.ctx, { ...CONFIG })
  const remote = agentFor(mirrorDir, fixture.tools)
  await fixture.listeners.get('agent/created')({ agent: remote.agent })
  let continued = 0
  await fixture.listeners.get('agent/pre-step')({ agent: remote.agent }, async () => { continued++ })
  assert.deepEqual(policyInputs, [{ session: remote.agent.session }])
  // A fixture without a subprocess service also degrades the search bridge;
  // that diagnostic is separate from the instruction-refresh warning.
  const refreshWarnings = warnings.filter((args) => /requires the negotiated remote helper root/.test(String(args[1])))
  assert.equal(refreshWarnings.length, 1)
  assert.equal(continued, 1)
  await fixture.listeners.get('agent/disposed')({ agent: remote.agent })
})

const assemblyFor = (names) => ({
  sections: [], contexts: [], variables: {},
  tools: names.map((name) => ({ name, description: name, parameters: { type: 'object' } })),
})

test('transparent mode is opt-in and unknown values preserve legacy routing', async () => {
  const { normalizeExecutionMode } = await import('../lib/index.js')
  assert.equal(normalizeExecutionMode(undefined), 'legacy')
  assert.equal(normalizeExecutionMode('legacy'), 'legacy')
  assert.equal(normalizeExecutionMode('transparent'), 'transparent')
  assert.equal(normalizeExecutionMode('typo'), 'legacy')
})
test('corrupt or missing mirror metadata fails closed instead of treating the path as local', async (t) => {
  const { home } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const brokenMirror = path.join(home, 'remote-workspaces', 'broken', 'proj')
  mkdirSync(brokenMirror, { recursive: true })
  const mod = await import(`../lib/index.js?transparent-broken=${Math.random()}`)
  const standardNames = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash']
  const fixture = makeCtx(standardNames)
  await mod.apply(fixture.ctx, { ...CONFIG })
  const broken = agentFor(brokenMirror, fixture.tools)

  await assert.rejects(fixture.listeners.get('agent/created')({ agent: broken.agent }), /cannot resolve remote mirror metadata/)
  assert.equal(broken.scoped.size, 0)
  assert.equal(fixture.calls.read || 0, 0)
})

test('transparent mode scopes standard overrides to remote mirrors and registers no rw_* tools', async (t) => {
  const { home, mirrorDir } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  process.env.DSH_HOME = home
  const mod = await import(`../lib/index.js?transparent=${Math.random()}`)
  const standardNames = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash']
  const fixture = makeCtx(standardNames)
  await mod.apply(fixture.ctx, { ...CONFIG })
  assert.deepEqual([...fixture.tools.keys()].filter((name) => name.startsWith('rw_')), [])

  const remote = agentFor(mirrorDir, fixture.tools)
  await fixture.listeners.get('agent/created')({ agent: remote.agent })
  assert.deepEqual([...remote.scoped.keys()], standardNames)
  assert.equal(remote.agent.ctx.tools.get('rw_exec', remote.agent), undefined)
  assert.equal(remote.denied.size, 0, 'unregistered rw_* tools need no restriction')

  const bash = remote.scoped.get('bash')
  await assert.rejects(bash.execute({ command: 'touch local-marker' }, { agent: remote.agent }), /DSH ShellExecutor resolver/)
  assert.equal(fixture.calls.bash || 0, 0)

  const local = agentFor(path.join(home, 'ordinary-local'), fixture.tools)
  await fixture.listeners.get('agent/created')({ agent: local.agent })
  assert.equal(local.scoped.size, 0)
  assert.equal(local.agent.ctx.tools.get('rw_exec', local.agent), undefined)

  const listener = fixture.listeners.get('system-prompt/assemble')
  const assembly = assemblyFor(['read', 'write', 'edit', 'rw_machines', 'rw_connect', 'rw_pick_workspace', 'rw_exec', 'rw_read_file'])
  const remoteResult = await listener(assembly, { agent: remote.agent }, async () => assembly)
  assert.deepEqual(remoteResult.tools.map((tool) => tool.name), ['read', 'write', 'edit'])
  const localResult = await listener(assembly, { agent: local.agent }, async () => assembly)
  assert.deepEqual(localResult.tools.map((tool) => tool.name), ['read', 'write', 'edit'])

  await fixture.listeners.get('agent/disposed')({ agent: remote.agent })
  assert.equal(remote.scoped.size, 0)
  assert.equal(remote.denied.size, 0)
  assert.equal(fixture.tools.get('bash').name, 'bash')
})

test('transparent mirror agents restrict only registered legacy tools and release them on disposal', async (t) => {
  const { home, mirrorDir } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const mod = await import(`../lib/index.js?transparent-existing-legacy=${Math.random()}`)
  const standardNames = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash']
  const fixture = makeCtx([...standardNames, 'rw_exec', 'rw_info'])
  await mod.apply(fixture.ctx, { ...CONFIG })
  const remote = agentFor(mirrorDir, fixture.tools)
  const local = agentFor(path.join(home, 'ordinary-local'), fixture.tools)

  await fixture.listeners.get('agent/created')({ agent: remote.agent })
  await fixture.listeners.get('agent/created')({ agent: local.agent })
  assert.deepEqual([...remote.denied].sort(), ['rw_exec', 'rw_info'])
  assert.equal(remote.agent.ctx.tools.get('rw_exec', remote.agent), undefined)
  assert.equal(local.agent.ctx.tools.get('rw_exec', local.agent), fixture.tools.get('rw_exec'))
  assert.deepEqual([...remote.scoped.keys()], standardNames)

  await fixture.listeners.get('agent/disposed')({ agent: remote.agent })
  assert.equal(remote.denied.size, 0)
  assert.equal(remote.scoped.size, 0)
  assert.equal(fixture.tools.has('rw_exec'), true)
})

test('legacy mode continues to register rw_* tools', async (t) => {
  const { home } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const mod = await import(`../lib/index.js?legacy-tools=${Math.random()}`)
  const fixture = makeCtx(['read', 'write', 'edit', 'bash'])
  await mod.apply(fixture.ctx, { ...CONFIG, executionMode: 'legacy' })
  const remoteNames = [...fixture.tools.keys()].filter((name) => name.startsWith('rw_'))
  assert.ok(remoteNames.length > 0)
  assert.ok(remoteNames.includes('rw_connect'))
  assert.ok(remoteNames.includes('rw_pick_workspace'))
})
test('native Cordis agent without skills injection registers its provider only in the agent scope', async (t) => {
  const { home, mirrorDir } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const app = new Context()
  let registry
  const skillsHost = app.plugin({ name: 'skills-host', apply(ctx) { registry = new SkillRegistry(ctx) } })
  await skillsHost
  const agent = { session: { header: { cwd: mirrorDir } } }
  let ownerCtx
  const owner = app.plugin({ name: 'agent-without-skills-inject', apply(ctx) { ownerCtx = ctx } })
  await owner
  const scope = createScope(ownerCtx, agent)
  t.after(() => scope.dispose())
  const names = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'skill']
  const fixture = makeCtx(names, app.skills)
  const toolsFixture = agentFor(mirrorDir, fixture.tools)
  agent.ctx = scope.ctx.extend({ tools: toolsFixture.agent.ctx.tools })
  assert.throws(() => agent.ctx.skills, /cannot get property "skills" without inject/)
  assert.equal(typeof agent.ctx.get('skills').registerProvider, 'function')

  const mod = await import(`../lib/index.js?native-transparent-skills=${Math.random()}`)
  await mod.apply(fixture.ctx, { ...CONFIG })
  await fixture.listeners.get('agent/created')({ agent })
  assert.equal(registry.layers.global.providers.isEmpty(), true)
  assert.ok(registry.layers.peek(agent).providers.get('dsh-remote-project'))
  assert.deepEqual([...toolsFixture.scoped.keys()], names.filter((name) => name !== 'skill'))

  await fixture.listeners.get('agent/disposed')({ agent })
  assert.equal(registry.layers.peek(agent), undefined)
  assert.equal(toolsFixture.scoped.size, 0)
})

test('new mirror sessions initialize through Cordis lifecycle with preset-scoped standard tools', async (t) => {
  const { home, mirrorDir } = makeHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const app = new Context()
  const scopes = []
  t.after(async () => {
    for (const scope of scopes.reverse()) await scope.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })
  app.provide('systemPrompt', { tools() {}, section() {} })
  const runtime = new ToolRuntime(app)
  let skills
  await app.plugin({ name: 'skills-host', apply(ctx) { skills = new SkillRegistry(ctx) } })
  const presetKey = {}
  const preset = createScope(app, presetKey)
  scopes.push(preset)
  const names = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'skill']
  const calls = {}
  for (const name of names) preset.ctx.tools.register(standardTool(name, calls))
  assert.equal(runtime.get('read'), undefined, 'standard tools belong to the preset, not the global registry')

  const mod = await import(`../lib/index.js?session-lifecycle=${Math.random()}`)
  await app.plugin({ name: 'remote-lifecycle', inject: mod.inject, apply(ctx) { return mod.apply(ctx, { ...CONFIG }) } })
  for (let i = 0; i < 2; i++) {
    const session = { id: `remote-session-${i}`, header: { cwd: mirrorDir } }
    const agent = { id: session.id, session }
    const scope = createScope(preset.ctx, agent, { parent: presetKey })
    scopes.push(scope)
    agent.ctx = scope.ctx
    const original = runtime.get('read', agent)
    await app.parallel(scopeTarget(app, agent), 'agent/created', { agent })
    assert.notEqual(runtime.get('read', agent).execute, original.execute)
    assert.equal(runtime.get('read', agent).parameters, original.parameters)
    assert.equal(runtime.get('read', presetKey), original)
    assert.equal(runtime.get('read'), undefined)
    assert.ok(skills.layers.peek(agent).providers.get('dsh-remote-project'))
    assert.equal(skills.layers.global.providers.isEmpty(), true)
    const assembly = await app.waterfall(scopeTarget(app, agent), 'system-prompt/assemble',
      assemblyFor([...names, 'rw_exec']), { agent }, async () => assemblyFor([...names, 'rw_exec']))
    assert.deepEqual(assembly.tools.map((tool) => tool.name), names)
    await app.parallel(scopeTarget(app, agent), 'agent/disposed', { agent })
    assert.equal(runtime.get('read', agent), original)
    assert.equal(runtime.layers.peek(agent), undefined)
    assert.equal(skills.layers.peek(agent), undefined)
  }
  const local = { session: { header: { cwd: path.join(home, 'local') } } }
  const localScope = createScope(preset.ctx, local, { parent: presetKey })
  scopes.push(localScope)
  local.ctx = localScope.ctx
  await app.parallel(scopeTarget(app, local), 'agent/created', { agent: local })
  assert.equal(runtime.get('read', local), runtime.get('read', presetKey))
  assert.equal(runtime.layers.peek(local), undefined)
  assert.equal(skills.layers.peek(local), undefined)
  assert.deepEqual(calls, {}, 'session initialization must not execute local standard tools')
})

test('project skill providers are scoped to mirror agents and disposed with the Agent', async (t) => {
  const { home, mirrorDir } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  process.env.DSH_HOME = home
  const mod = await import(`../lib/index.js?transparent-skills=${Math.random()}`)
  const names = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'skill']
  const skillsService = { async snapshot() { return { skills: [], complete: true } } }
  const fixture = makeCtx(names, skillsService)
  await mod.apply(fixture.ctx, { ...CONFIG })

  const remote = agentFor(mirrorDir, fixture.tools, skillsService)
  await fixture.listeners.get('agent/created')({ agent: remote.agent })
  assert.deepEqual([...remote.skillProviders.keys()], ['dsh-remote-project'])

  const local = agentFor(path.join(home, 'ordinary-local'), fixture.tools, skillsService)
  await fixture.listeners.get('agent/created')({ agent: local.agent })
  assert.equal(local.skillProviders.size, 0)

  await fixture.listeners.get('agent/disposed')({ agent: remote.agent })
  assert.equal(remote.skillProviders.size, 0)
})

test('an incomplete or failing host snapshot degrades instead of skipping remote skills', async (t) => {
  const { home, mirrorDir } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  process.env.DSH_HOME = home
  const mod = await import(`../lib/index.js?transparent-skills-degraded=${Math.random()}`)
  const names = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'skill']

  // An incomplete host snapshot used to throw out of agent/created, which left
  // the agent with no remote skill provider and no transparent tool overrides.
  const incomplete = { async snapshot() { return { skills: [], complete: false } } }
  const fixture = makeCtx(names, incomplete)
  await mod.apply(fixture.ctx, { ...CONFIG })
  const partial = agentFor(mirrorDir, fixture.tools, incomplete)
  await fixture.listeners.get('agent/created')({ agent: partial.agent })
  assert.deepEqual([...partial.skillProviders.keys()], ['dsh-remote-project'])

  // A snapshot that throws must not be fatal either.
  const throwing = { async snapshot() { throw new Error('host skill layer is unreadable') } }
  const broken = makeCtx(names, throwing)
  await mod.apply(broken.ctx, { ...CONFIG })
  const degraded = agentFor(mirrorDir, broken.tools, throwing)
  await broken.listeners.get('agent/created')({ agent: degraded.agent })
  assert.deepEqual([...degraded.skillProviders.keys()], ['dsh-remote-project'])
})

test('pre-step installs transparent overrides for a resumed remote session', async (t) => {
  const { home, mirrorDir } = makeHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })
  const mod = await import(`../lib/index.js?pre-step-heal=${Math.random()}`)
  const fixture = makeCtx(['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash'])
  await mod.apply(fixture.ctx, { ...CONFIG })
  const remote = agentFor(mirrorDir, fixture.tools)

  // A session restored from disk never emitted agent/created: its tool scope
  // still resolves the local standard tools.
  assert.equal(remote.scoped.size, 0)
  let continued = 0
  const result = await fixture.listeners.get('agent/pre-step')({ agent: remote.agent }, async () => {
    continued += 1
    return 'continued'
  })
  assert.equal(result, 'continued')
  assert.equal(continued, 1)
  assert.ok(remote.scoped.has('read'))
  assert.ok(remote.scoped.has('bash'))
  assert.notEqual(remote.scoped.get('read'), fixture.tools.get('read'))

  await fixture.listeners.get('agent/disposed')({ agent: remote.agent })
  assert.equal(remote.scoped.size, 0)
})

test('pre-step keeps standard tools fail-closed when a remote session cannot be set up', async (t) => {
  const { home } = makeHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })
  const brokenCwd = path.join(home, 'remote-workspaces', '127.0.0.11-lucas-1', 'broken')
  mkdirSync(brokenCwd, { recursive: true })
  const mod = await import(`../lib/index.js?pre-step-failclosed=${Math.random()}`)
  const fixture = makeCtx(['read', 'bash'])
  await mod.apply(fixture.ctx, { ...CONFIG })
  const remote = agentFor(brokenCwd, fixture.tools)

  const result = await fixture.listeners.get('agent/pre-step')({ agent: remote.agent }, async () => 'continued')
  assert.equal(result, 'continued')
  const stub = remote.scoped.get('read')
  assert.ok(stub, 'read must be replaced by a fail-closed stub')
  await assert.rejects(
    stub.execute({ file_path: '/root/remote/file' }, { agent: remote.agent, signal: new AbortController().signal }),
    (error) => error.code === 'REMOTE_TRANSPARENT_SETUP_FAILED',
  )
  assert.equal(fixture.calls.read, undefined)

  // The retry window keeps the stubs; a second step must not quietly fall back.
  await fixture.listeners.get('agent/pre-step')({ agent: remote.agent }, async () => 'continued')
  assert.equal(remote.scoped.get('read'), stub)
  await fixture.listeners.get('agent/disposed')({ agent: remote.agent })
})
