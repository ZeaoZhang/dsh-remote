import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { remoteMcpCommand, remoteMcpToolName, RemoteMcpStdioTransport, installRemoteMcpServers } from '../lib/remote-mcp.js'

function channel() {
  const readable = new PassThrough()
  const stderr = new PassThrough()
  const writes = []
  const writable = new Writable({ write(chunk, _encoding, done) { writes.push(chunk.toString()); done() } })
  let closed = 0
  return { readable, writable, stderr, writes, close() { closed++; readable.destroy() }, get closed() { return closed } }
}

function fixture({ toolList, registerFailure = false, stalled = false } = {}) {
  const channels = []
  const commands = []
  const calls = []
  const clients = []
  const registrations = new Map()
  const resourceProviders = new Map()
  const sections = new Map()
  const pool = { async openExecChannel(command) { commands.push(command); const stream = channel(); channels.push(stream); return stream } }
  let binding = { pool, ws: '/srv/project' }
  const ctx = {
    tools: { register(definition) {
      if (registerFailure && registrations.size) throw new Error('registration conflict')
      registrations.set(definition.name, definition)
      return () => registrations.delete(definition.name)
    } },
    get(name) {
      if (name === 'mcpResources') return { register(name, provider) { resourceProviders.set(name, provider); return () => resourceProviders.delete(name) } }
      if (name === 'systemPrompt') return { getSectionOrder: () => 1, section(section) { sections.set(section.name, section); return () => sections.delete(section.name) } }
    },
  }
  const sdk = {
    Client: class {
      constructor() { clients.push(this) }
      async connect(transport) { this.transport = transport; await transport.start(); if (stalled) await new Promise(() => {}) }
      getServerCapabilities() { return { tools: {} } }
      async listTools() { return { tools: toolList ?? [{ name: 'read-file', inputSchema: { type: 'object' } }] } }
      async callTool(args, options) { calls.push({ args, options }); return { content: [{ type: 'text', text: 'remote' }] } }
      getInstructions() { return 'Remote instructions ${unexpanded}' }
      async listResources(args, options) { return { args, options } }
      async listResourceTemplates(args, options) { return { args, options } }
      async readResource(args, options) { return { args, options } }
      async close() { this.closed = true; await this.transport?.close() }
    },
    createMcpToolDefinition(_ctx, opts) { return { name: opts.name, execute: opts.call, options: opts } },
  }
  const options = { agent: { ctx }, servers: [{ serverName: 'files', transport: 'stdio', command: 'node', args: ['server.mjs'] }], resolveBinding: async () => binding, sdk }
  return { options, channels, commands, clients, calls, registrations, resourceProviders, sections, setBinding(value) { binding = value } }
}

test('remote MCP shell command quotes every configured value and uses remote cwd/env', () => {
  assert.equal(remoteMcpCommand({ transport: 'stdio', command: 'node', args: ["a'b", '$(touch /tmp/no)'], env: { TOKEN: 'secret value' }, cwd: 'server dir' }, '/srv/work'), "cd '/srv/work/server dir' && exec env -- TOKEN='secret value' 'node' 'a'\\''b' '$(touch /tmp/no)'")
  assert.throws(() => remoteMcpCommand({ transport: 'stdio', command: 'node', env: { 'BAD;KEY': 'x' } }, '/srv'), /invalid MCP environment/)
  assert.throws(() => remoteMcpCommand({ transport: 'stdio', command: 'node\0bad' }, '/srv'), /NUL/)
  assert.throws(() => remoteMcpCommand({ transport: 'streamable-http', url: 'http://remote' }, '/srv'), /HTTP requires/)
  assert.throws(() => remoteMcpCommand({ transport: 'stdio', command: 'node' }, 'C:\\workspace'), /POSIX/)
})

test('tool names match DSH naming contract without lossy collisions', () => {
  assert.equal(remoteMcpToolName('files', 'read-file'), 'mcp__files__read-file')
  const a = remoteMcpToolName('files', 'read.file')
  assert.match(a, /^mcp__files__read_file_[a-f0-9]{12}$/)
  assert.notEqual(a, remoteMcpToolName('files', 'read/file'))
  assert.equal(remoteMcpToolName('files', 'a'.repeat(100)).length, 64)
})

test('SSH MCP transport handles fragmented UTF-8 and keeps stderr off protocol', async () => {
  const stream = channel()
  const transport = new RemoteMcpStdioTransport({ openExecChannel: async () => stream }, 'remote-only')
  const messages = []
  let closed = 0
  transport.onmessage = (value) => messages.push(value)
  transport.onclose = () => closed++
  await transport.start()
  const bytes = Buffer.from('{"text":"你好"}\n{"id":2}\n')
  stream.readable.write(bytes.subarray(0, 11))
  stream.readable.write(bytes.subarray(11))
  stream.stderr.write('not JSON and possibly secrets')
  assert.deepEqual(messages, [{ text: '你好' }, { id: 2 }])
  await transport.send({ jsonrpc: '2.0', id: 1 })
  assert.deepEqual(stream.writes, ['{"jsonrpc":"2.0","id":1}\n'])
  await transport.close()
  await transport.close()
  assert.equal(closed, 1)
  assert.equal(stream.closed, 1)
  await assert.rejects(transport.send({}), /disconnected/)
})

test('transport rejects malformed or oversized incoming frames and closes channel', async () => {
  for (const input of ['bad json\n', 'x'.repeat(30)]) {
    const stream = channel()
    const transport = new RemoteMcpStdioTransport({ openExecChannel: async () => stream }, 'remote', { maxMessageBytes: 20 })
    const errors = []
    transport.onerror = (error) => errors.push(error)
    await transport.start()
    stream.readable.write(input)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(errors.length, 1)
    assert.equal(transport.closed, true)
    assert.equal(stream.closed, 1)
  }
})

test('remote servers publish tools/resources/instructions only on their Agent', async () => {
  const a = fixture()
  const b = fixture()
  const disposeA = await installRemoteMcpServers(a.options)
  const disposeB = await installRemoteMcpServers(b.options)
  assert.equal(a.commands.length, 1)
  assert.match(a.commands[0], /^cd '\/srv\/project' && exec env -- 'node' 'server.mjs'$/)
  const tool = a.registrations.get('mcp__files__read-file')
  const controller = new AbortController()
  assert.deepEqual(await tool.execute({ file: 'a' }, { signal: controller.signal }), { content: [{ type: 'text', text: 'remote' }] })
  assert.equal(a.calls[0].args.name, 'read-file')
  assert.equal(a.calls[0].options.signal, controller.signal)
  const resource = await a.resourceProviders.get('files').request({ method: 'resources/read', uri: 'file:///srv/a' }, { signal: controller.signal })
  assert.deepEqual(resource.args, { uri: 'file:///srv/a' })
  assert.equal(a.sections.get('mcp:files').interpolate, false)
  assert.match(a.sections.get('mcp:files').text(), /\$\{unexpanded\}/)
  await disposeA()
  assert.equal(a.registrations.size, 0)
  assert.equal(a.resourceProviders.size, 0)
  assert.equal(a.sections.size, 0)
  assert.equal(a.channels[0].closed, 1)
  assert.equal(b.registrations.size, 1)
  await assert.rejects(tool.execute({}, {}), /disposed/)
  await disposeB()
})

test('binding changes fail closed without invoking the old remote server', async () => {
  const f = fixture()
  const dispose = await installRemoteMcpServers(f.options)
  f.setBinding({ pool: {}, ws: '/other' })
  await assert.rejects(f.registrations.values().next().value.execute({}, {}), /binding changed/)
  assert.equal(f.calls.length, 0)
  await dispose()
})

test('partial tool registration failure rolls back all processes and registrations', async () => {
  const f = fixture({ registerFailure: true, toolList: [{ name: 'one' }, { name: 'two' }] })
  await assert.rejects(installRemoteMcpServers(f.options), /registration conflict/)
  assert.equal(f.registrations.size, 0)
  assert.equal(f.channels[0].closed, 1)
})

test('invalid later config opens no earlier server processes', async () => {
  const f = fixture()
  f.options.servers.push({ serverName: 'bad', transport: 'stdio', command: 'bad\0command' })
  await assert.rejects(installRemoteMcpServers(f.options), /NUL/)
  assert.equal(f.commands.length, 0)
})

test('duplicate server/tool names fail and close processes', async () => {
  const f = fixture()
  f.options.servers.push(f.options.servers[0])
  await assert.rejects(installRemoteMcpServers(f.options), /valid and unique/)
  assert.equal(f.commands.length, 0)
  const g = fixture({ toolList: [{ name: 'duplicate' }, { name: 'duplicate' }] })
  await assert.rejects(installRemoteMcpServers(g.options), /duplicate tool/)
  assert.equal(g.channels[0].closed, 1)
})

test('timeout and Agent cancellation close remote processes', async () => {
  const f = fixture({ stalled: true })
  await assert.rejects(installRemoteMcpServers({ ...f.options, startupTimeoutMs: 10 }), /timed out/)
  assert.equal(f.channels[0].closed, 1)
  const g = fixture()
  const controller = new AbortController()
  await installRemoteMcpServers({ ...g.options, signal: controller.signal })
  controller.abort()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(g.registrations.size, 0)
  assert.equal(g.channels[0].closed, 1)
})
