import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { parseRemoteMcpConfigs, discoverRemoteMcpServers, createRemoteMcpState, formatRemoteMcpStatus } from '../lib/remote-mcp-config.js'

function snapshot(entries) {
  return { root: '/srv/project', files: entries.map(([filePath, mcpServers]) => ({ path: filePath, text: JSON.stringify({ mcpServers }) })) }
}

test('remote config merge uses user then project declarations and disabled removes names', () => {
  const result = parseRemoteMcpConfigs(snapshot([
    ['/home/user/.dsh/mcp.json', { files: { command: 'old' }, removed: { command: 'gone' } }],
    ['/srv/project/.mcp.json', { files: { command: 'project', args: ['server.js'] }, removed: { disabled: true } }],
    ['/srv/project/.dsh/mcp.json', { files: { type: 'stdio', command: 'final', env: { KEY: 'value' } } }],
  ]), '/srv/project')
  assert.deepEqual(result.servers, [{ serverName: 'files', transport: 'stdio', command: 'final', env: { KEY: 'value' } }])
  assert.equal(result.sources.length, 3)
  assert.throws(() => parseRemoteMcpConfigs(snapshot([['/srv/project/.mcp.json', { web: { url: 'http://localhost:1234' } }]]), '/srv/project'), /remote HTTP transport is not implemented/)
  assert.throws(() => parseRemoteMcpConfigs({ root: '/other', files: [] }, '/srv/project'), /invalid remote MCP/)
  assert.throws(() => parseRemoteMcpConfigs({ root: '/srv/project', files: [{ path: '/srv/project/.mcp.json', text: 'secret invalid json' }] }, '/srv/project'), /Invalid JSON in remote MCP config/)
})

test('config discovery runs bounded reader on SSH host', async () => {
  let command
  let options
  const result = await discoverRemoteMcpServers({ binding: { ws: '/srv/project', pool: { async exec(cmd, opts) {
    command = cmd; options = opts
    return { code: 0, stdout: JSON.stringify(snapshot([['/srv/project/.mcp.json', { files: { command: 'node' } }]])) }
  } } }, nodeCommand: '/remote/bin/node' })
  assert.equal(result.servers[0].command, 'node')
  assert.match(command, /^'\/remote\/bin\/node' -e /)
  assert.match(command, /process.env.DSH_HOME/)
  assert.match(command, /131073/)
  assert.equal(options.timeoutMs, 15_000)
  await assert.rejects(discoverRemoteMcpServers({ binding: { ws: '/srv/project', pool: { exec: async () => ({ code: 1, stderr: 'missing node' }) } } }), /missing node/)
})

function fixture() {
  const registrations = new Map()
  const inherited = new Map([
    ['mcp__local__danger', { name: 'mcp__local__danger', execute: () => { throw new Error('local executed') } }],
    ['list_mcp_resources', { name: 'list_mcp_resources', execute: (args) => ({ server: args.server }) }],
  ])
  const denied = new Set()
  const guards = []
  const tools = {
    view: () => ({ visible: new Map([...inherited].filter(([name]) => !denied.has(name)).concat([...registrations])), restrictableNames: new Set(inherited.keys()) }),
    get: (name) => tools.view().visible.get(name),
    restrict: ({ deny }) => { deny.forEach((name) => denied.add(name)); return () => deny.forEach((name) => denied.delete(name)) },
    guard: (guard) => { guards.push(guard); return () => guards.splice(guards.indexOf(guard), 1) },
    register: (definition) => { registrations.set(definition.name, definition); return () => registrations.delete(definition.name) },
  }
  const pool = {
    async exec() { return { code: 0, stdout: JSON.stringify(snapshot([['/srv/project/.mcp.json', { files: { command: 'node' } }]])) } },
    async openExecChannel() { return { readable: new PassThrough(), writable: new Writable({ write(_c, _e, done) { done() } }), close() {} } },
  }
  const sdk = {
    Client: class {
      async connect(transport) { this.transport = transport; await transport.start() }
      getServerCapabilities() { return { tools: {} } }
      async listTools() { return { tools: [{ name: 'read-file', inputSchema: { type: 'object' } }] } }
      async close() { await this.transport?.close() }
    },
    createMcpToolDefinition(_ctx, opts) { return { name: opts.name, execute: opts.call } },
  }
  const agent = { ctx: { tools, get: (name) => name === 'mcpResources' ? { register: () => () => {} } : undefined } }
  return { options: { agent, resolveBinding: async () => ({ pool, ws: '/srv/project' }), sdk }, tools, inherited, guards, registrations, pool }
}

test('config state masks inherited MCP tools and blocks local resource fallback per Agent', async () => {
  const f = fixture()
  const other = fixture()
  const state = await createRemoteMcpState(f.options)
  assert.equal(f.tools.get('mcp__local__danger'), undefined)
  assert.ok(other.tools.get('mcp__local__danger'))
  assert.equal(f.guards[0]({ name: 'mcp__files__read-file', agent: f.options.agent }), undefined)
  f.inherited.set('mcp__newlocal__tool', { name: 'mcp__newlocal__tool' })
  assert.match(f.guards[0]({ name: 'mcp__newlocal__tool', agent: f.options.agent }), /Local MCP tools/)
  assert.match(f.guards[0]({ name: 'list_mcp_resources', arguments: { server: 'local' } }), /not configured on this remote Agent/)
  assert.equal(f.guards[0]({ name: 'list_mcp_resources', arguments: { server: 'files' } }), undefined)
  assert.deepEqual(state.servers, [{ serverName: 'files', transport: 'stdio' }])
  await state.dispose()
  assert.ok(f.tools.get('mcp__local__danger'))
  assert.equal(f.guards.length, 0)
  assert.equal(f.registrations.size, 0)
})

test('unsupported HTTP declaration restores scoped masks and guard after failure', async () => {
  const f = fixture()
  f.pool.exec = async () => ({ code: 0, stdout: JSON.stringify(snapshot([['/srv/project/.mcp.json', { web: { url: 'http://remote' } }]])) })
  await assert.rejects(createRemoteMcpState(f.options), /remote HTTP transport is not implemented/)
  assert.ok(f.tools.get('mcp__local__danger'))
  assert.equal(f.guards.length, 0)
})

test('empty remote config succeeds without loading SDK and disposes cleanly', async () => {
  const f = fixture()
  f.pool.exec = async () => ({ code: 0, stdout: JSON.stringify(snapshot([])) })
  const state = await createRemoteMcpState({ ...f.options, sdk: undefined })
  assert.deepEqual(state.servers, [])
  assert.deepEqual(state.sources, [])
  assert.match(f.guards[0]({ name: 'list_mcp_resources', arguments: { server: 'local' } }), /not configured/)
  await state.dispose()
  await state.dispose()
  assert.equal(f.guards.length, 0)
})

test('status exposes only server names, transport, source paths and format', () => {
  const input = { servers: [{ serverName: 'files', transport: 'stdio', command: 'secret-command', env: { PASSWORD: 'secret' } }], sources: ['/srv/project/.mcp.json'], hostname: 'private-host', password: 'secret', format: 'description' }
  const result = formatRemoteMcpStatus(input)
  assert.deepEqual(result, { servers: [{ name: 'files', transport: 'stdio' }], sources: ['/srv/project/.mcp.json'], format: 'description' })
  result.sources.push('new')
  assert.equal(input.sources.length, 1)
})

test('binding change after discovery cannot start old host configs on a new host', async () => {
  const f = fixture()
  const initial = await f.options.resolveBinding()
  let calls = 0
  let opened = 0
  initial.pool.openExecChannel = async () => { opened++; throw new Error('must not launch') }
  await assert.rejects(createRemoteMcpState({ ...f.options, resolveBinding: async () => ++calls === 1 ? initial : { pool: { openExecChannel: initial.pool.openExecChannel }, ws: initial.ws } }), /binding changed/)
  assert.equal(opened, 0)
  assert.equal(f.guards.length, 0)
})

test('maskRemoteMcpCapabilities closes inherited MCP access when remote MCP cannot start', async () => {
  const { maskRemoteMcpCapabilities } = await import('../lib/remote-mcp-config.js')
  const denied = new Set()
  const guards = []
  const mcpResource = { name: 'read_mcp_resource' }
  const agent = {
    ctx: {
      tools: {
        view: () => ({ visible: new Map([['mcp__local__search', {}]]), restrictableNames: new Set(['mcp__local__search']) }),
        restrict({ deny }) { deny.forEach((name) => denied.add(name)); return () => deny.forEach((name) => denied.delete(name)) },
        get: (name) => name === 'read_mcp_resource' ? mcpResource : undefined,
        guard(fn) { guards.push(fn); return () => guards.splice(guards.indexOf(fn), 1) },
      },
    },
  }
  const release = maskRemoteMcpCapabilities(agent)
  assert.deepEqual([...denied], ['mcp__local__search'])
  assert.match(guards[0]({ name: 'mcp__local__search', agent }), /local MCP tools are unavailable/)
  assert.match(guards[0]({ name: 'read_mcp_resource', arguments: { server: 'local' } }), /is not configured on this remote Agent/)
  assert.equal(guards[0]({ name: 'read', arguments: {} }), undefined)
  release()
  assert.equal(denied.size, 0)
  assert.equal(guards.length, 0)
  assert.equal(maskRemoteMcpCapabilities({ ctx: {} })(), undefined, 'unsupported runtimes degrade to a no-op disposer')
})
