import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { installTransparentSearchBridge } from '../lib/transparent-search.js'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'


function fixture(t, options = {}) {
  const mirrorDir = mkdtempSync(path.join(tmpdir(), 'dsh-transparent-search-'))
  t.after(() => rmSync(mirrorDir, { recursive: true, force: true }))
  mkdirSync(path.join(mirrorDir, 'src'), { recursive: true })
  const output = options.output || Buffer.from('a.js\n')
  const emptyHash = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
  const outputHash = createHash('sha256').update(output).digest('hex')
  const remoteCalls = []
  const localCalls = []
  const signal = new AbortController().signal
  const globalTools = new Map()
  const subprocess = {
    spawn(spec) {
      localCalls.push(spec)
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: 'local.js\n', lossy: false }) },
          stderr: { readFrom: () => ({ text: '', lossy: false }) },
        },
      }
    },
    spawnTerminal(spec) { localCalls.push({ terminal: spec }); return { local: true } },
  }
  const originalSpawn = subprocess.spawn
  const tools = {
    get(name) { return globalTools.get(name) },
  }
  let onToolsChange
  const bridge = installTransparentSearchBridge({
    tools,
    subprocess,
    resolveBinding(exec) {
      if (exec?.agent?.remote) return { bound: true, ws: '/srv/project', mirrorDir, pool: {} }
      return { bound: false, local: true }
    },
    resolveBindingForCwd(cwd) {
      if (typeof cwd === 'string' && path.resolve(cwd).startsWith(mirrorDir + path.sep)) {
        return { bound: true, ws: '/srv/project', mirrorDir, pool: {} }
      }
      return { bound: false, local: true }
    },
    async getHelper() {
      return {
        root: '/srv/project',
        rpc: { async request(op, payload, options) {
          remoteCalls.push({ op, payload, options })
          if (op === 'search_begin') return {
            transferId: 'transfer-1', exitCode: 0, signal: null,
            stdoutBytes: output.length, stderrBytes: 0,
            stdoutLossy: false, stderrLossy: false,
            stdoutHash: outputHash, stderrHash: emptyHash, chunkSize: 1024,
          }
          if (op === 'search_chunk') {
            const source = payload.stream === 'stdout' ? output : Buffer.alloc(0)
            return {
              transferId: payload.transferId,
              stream: payload.stream,
              offset: payload.offset,
              hash: payload.stream === 'stdout' ? outputHash : emptyHash,
              data: source.subarray(payload.offset, payload.offset + payload.length).toString('base64'),
            }
          }
          if (op === 'search_release') return { released: true }
          throw new Error(`unexpected remote op ${op}`)
        } },
      }
    },
    onToolsChange(listener) {
      onToolsChange = listener
      return () => { onToolsChange = undefined }
    },
  })
  const exec = { signal, agent: { remote: true, session: { header: { cwd: mirrorDir } } } }
  const glob = {
    name: 'glob',
    async execute(args, toolExec) {
      const handle = subprocess.spawn({
        argv: ['/local/rg', '--no-config', '--files', `--glob=${args.pattern}`, '--sort=modified', '--no-ignore', '--hidden', '--glob=!**/.git', '--glob=!**/.git/**', '--', args.path],
        cwd: path.join(mirrorDir, 'src'),
        stdio: { stdout: { maxBytes: 20_000_000 }, stderr: { maxBytes: 64 * 1024 } },
        graceMs: 3000,
        signal: toolExec.signal,
      })
      const outcome = await handle.done
      const raw = handle.collected.stdout.readFrom(0)
      if (outcome.exitCode !== 0) throw new Error('search failed')
      return { root: args.path, paths: raw.text.trim().split('\n') }
    },
  }
  const originalGlobExecute = glob.execute
  globalTools.set('glob', glob)
  onToolsChange?.()
  return { bridge, exec, globalTools, localCalls, mirrorDir, originalGlobExecute, originalSpawn, remoteCalls, signal, subprocess, tools }
}

test('native glob retains identity and receives remote search with DSH caps and cancellation', async (t) => {
  const state = fixture(t)
  const original = state.globalTools.get('glob')
  const results = await original.execute({ pattern: '**/*.js', path: '../lib' }, state.exec)

  assert.equal(state.globalTools.get('glob'), original)
  assert.deepEqual(results, { root: '../lib', paths: ['a.js'] })
  assert.equal(state.localCalls.length, 0)
  const begin = state.remoteCalls.find(({ op }) => op === 'search_begin')
  assert.deepEqual(begin.payload, {
    kind: 'glob',
    cwd: '/srv/project/src',
    argv: ['--no-config', '--files', '--glob=**/*.js', '--sort=modified', '--no-ignore', '--hidden', '--glob=!**/.git', '--glob=!**/.git/**', '--', '../lib'],
    stdoutMaxBytes: 20_000_000,
    stderrMaxBytes: 64 * 1024,
    graceMs: 3000,
  })
  assert.equal(begin.options.signal instanceof AbortSignal, true)
  assert.equal(state.remoteCalls.at(-1).op, 'search_release')
})

test('native Cordis services share the patched provider and preserve ToolRuntime tool identity', async (t) => {
  const mirrorDir = mkdtempSync(path.join(tmpdir(), 'dsh-cordis-search-'))
  t.after(() => rmSync(mirrorDir, { recursive: true, force: true }))
  mkdirSync(path.join(mirrorDir, 'src'), { recursive: true })
  const app = new Context()
  app.systemPrompt = { tools() {}, section() {} }
  const runtime = new ToolRuntime(app)
  const localCalls = []
  class Subprocess extends Service {
    constructor(ctx) { super(ctx, 'subprocess') }
    spawn(spec) {
      localCalls.push(spec)
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: 'local.js\n', lossy: false }) },
          stderr: { readFrom: () => ({ text: '', lossy: false }) },
        },
      }
    }
  }
  const subprocess = new Subprocess(app)
  let searchPluginCtx
  await app.plugin({ name: 'search-probe', inject: ['tools', 'subprocess'], apply(ctx) { searchPluginCtx = ctx } })
  const output = Buffer.from('remote.js\n')
  const hash = createHash('sha256').update(output).digest('hex')
  const emptyHash = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
  const remoteCalls = []
  const bridge = installTransparentSearchBridge({
    tools: app.tools,
    subprocess: app.subprocess,
    resolveBinding(exec) {
      return exec?.agent?.remote ? { bound: true, ws: '/srv/project', mirrorDir, pool: {} } : { bound: false, local: true }
    },
    resolveBindingForCwd(cwd) {
      return typeof cwd === 'string' && path.resolve(cwd).startsWith(mirrorDir + path.sep)
        ? { bound: true, ws: '/srv/project', mirrorDir, pool: {} }
        : { bound: false, local: true }
    },
    async getHelper() {
      return { root: '/srv/project', rpc: { async request(op, payload) {
        remoteCalls.push({ op, payload })
        if (op === 'search_begin') return {
          transferId: 'cordis-transfer', exitCode: 0, signal: null,
          stdoutBytes: output.length, stderrBytes: 0, stdoutLossy: false, stderrLossy: false,
          stdoutHash: hash, stderrHash: emptyHash, chunkSize: 1024,
        }
        if (op === 'search_chunk') return {
          transferId: payload.transferId, stream: payload.stream, offset: payload.offset,
          hash: payload.stream === 'stdout' ? hash : emptyHash,
          data: (payload.stream === 'stdout' ? output : Buffer.alloc(0)).subarray(payload.offset, payload.offset + payload.length).toString('base64'),
        }
        if (op === 'search_release') return { released: true }
        throw new Error(`unexpected operation ${op}`)
      } } }
    },
    onToolsChange: (listener) => app.on('tools/change', listener),
  })

  const definition = defineTool({
    name: 'glob',
    description: 'Find remote paths',
    parameters: { pattern: { type: 'string', required: true }, path: { type: 'string' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { root: { type: 'string', required: true }, paths: { type: 'array', required: true, items: { type: 'string' } } } },
      render: (_args, value) => [{ type: 'text', text: value.paths.join('\n') }],
    },
    async execute(args, exec) {
      const handle = searchPluginCtx.subprocess.spawn({
        argv: ['/packaged/rg', '--no-config', '--files', `--glob=${args.pattern}`, '--sort=modified', '--no-ignore', '--hidden', '--glob=!**/.git', '--glob=!**/.git/**', '--', args.path],
        cwd: path.join(mirrorDir, 'src'),
        stdio: { stdout: { maxBytes: 20_000_000 }, stderr: { maxBytes: 64 * 1024 } },
        graceMs: 3000,
        signal: exec.signal,
      })
      const outcome = await handle.done
      if (outcome.exitCode !== 0) throw new Error('search failed')
      return { root: args.path, paths: handle.collected.stdout.readFrom(0).text.trim().split('\n') }
    },
  })
  const originalExecute = definition.execute
  const unregister = runtime.register(definition)
  assert.equal(bridge.isSearchToolWrapped('glob', app.tools.get('glob')), true)
  const exec = { signal: new AbortController().signal, agent: { remote: true, session: { header: { cwd: mirrorDir } } } }
  const result = await app.tools.get('glob').execute({ pattern: '**/*.js', path: '../lib' }, exec)

  assert.equal(app.tools.get('glob'), definition)
  assert.deepEqual(result, { root: '../lib', paths: ['remote.js'] })
  assert.equal(localCalls.length, 0)
  assert.equal(remoteCalls[0].op, 'search_begin')
  assert.equal(searchPluginCtx.subprocess[Symbol.for('cordis.original')], subprocess)

  bridge.dispose()
  assert.equal(definition.execute, originalExecute)
  assert.equal(Object.hasOwn(subprocess, 'spawn'), false)
  unregister()
})

test('local subprocess remains local and unmarked remote subprocess fails closed', async (t) => {
  const state = fixture(t)
  const localExec = { signal: new AbortController().signal, agent: { remote: false } }
  await state.globalTools.get('glob').execute({ pattern: '*.js', path: '.' }, localExec)
  assert.equal(state.localCalls.length, 1)
  assert.equal(state.remoteCalls.length, 0)

  assert.throws(() => state.subprocess.spawn({ cwd: path.join(state.mirrorDir, 'src'), argv: ['/bin/echo', 'no'] }), /refused local execution/)
  assert.equal(state.localCalls.length, 1)
})

test('disposing restores the original tool and subprocess service', (t) => {
  const state = fixture(t)
  const originalToolExecute = state.originalGlobExecute
  const originalSpawn = state.originalSpawn
  state.bridge.dispose()

  assert.equal(state.globalTools.get('glob').execute, originalToolExecute)
  assert.equal(state.subprocess.spawn, originalSpawn)
})

// Regression: standard tool plugins register inside an ISOLATED preset scope
// (dsh-agent-preset-registry uses createScope + mountPreset), so the agent-visible
// glob/grep definition is NOT the one the global view returns. The bridge must
// wrap the object its caller actually resolves, or transparent mode shadows a
// working native search tool with the fail-closed `unsupportedExecute` override.
test('wraps preset-scoped search definitions the global view cannot see', async (t) => {
  const mirrorDir = mkdtempSync(path.join(tmpdir(), 'dsh-preset-search-'))
  t.after(() => rmSync(mirrorDir, { recursive: true, force: true }))
  mkdirSync(path.join(mirrorDir, 'src'), { recursive: true })

  const app = new Context()
  app.systemPrompt = { tools() {}, section() {} }
  const runtime = new ToolRuntime(app)
  const localCalls = []
  class Subprocess extends Service {
    constructor(ctx) { super(ctx, 'subprocess') }
    spawn(spec) {
      localCalls.push(spec)
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: '', lossy: false }) },
          stderr: { readFrom: () => ({ text: '', lossy: false }) },
        },
      }
    }
  }
  new Subprocess(app)

  const presetKey = {}
  const preset = createScope(app, presetKey)
  t.after(() => preset.dispose())
  const definitions = {}
  for (const name of ['glob', 'grep']) {
    definitions[name] = defineTool({
      name,
      description: name,
      parameters: { pattern: { type: 'string', required: true } },
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
      async execute() { return { name } },
    })
    preset.ctx.tools.register(definitions[name])
  }
  // The premise of the regression: the global view resolves neither tool.
  assert.equal(app.tools.get('glob'), undefined)
  assert.equal(app.tools.get('grep'), undefined)

  const bridge = installTransparentSearchBridge({
    tools: app.tools,
    subprocess: app.subprocess,
    resolveBinding: () => ({ bound: true, ws: '/srv/project', mirrorDir, pool: {} }),
    resolveBindingForCwd: () => ({ bound: true, ws: '/srv/project', mirrorDir, pool: {} }),
    getHelper: async () => ({ rpc: { request: async () => ({}) } }),
    onToolsChange: (listener) => app.on('tools/change', listener),
  })
  t.after(() => bridge.dispose())
  assert.equal(typeof bridge?.isSearchToolWrapped, 'function')

  const agent = { session: { header: { cwd: mirrorDir } } }
  const scope = createScope(preset.ctx, agent, { parent: presetKey })
  t.after(() => scope.dispose())
  agent.ctx = scope.ctx

  const originalGlobExecute = definitions.glob.execute
  const visibleGlob = app.tools.get('glob', agent)
  const visibleGrep = app.tools.get('grep', agent)
  assert.equal(visibleGlob, definitions.glob)
  assert.notEqual(visibleGlob, undefined)

  // No scope argument must not throw, and must not claim a foreign definition.
  assert.equal(bridge.isSearchToolWrapped('glob', undefined), false)
  assert.equal(bridge.isSearchToolWrapped('glob', visibleGlob, agent), true)
  assert.equal(bridge.isSearchToolWrapped('grep', visibleGrep, agent), true)
  // Wrapping is in place: the preset definition the agent resolves keeps identity.
  assert.equal(app.tools.get('glob', agent), visibleGlob)
  assert.notEqual(visibleGlob.execute, originalGlobExecute)
  assert.equal(localCalls.length, 0)
})
