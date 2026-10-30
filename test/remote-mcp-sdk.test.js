import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { installRemoteMcpServers, remoteMcpCommand } from '../lib/remote-mcp.js'

test('workspace placeholders expand remotely; env interpolation stays literal', () => {
  const command = remoteMcpCommand({ transport: 'stdio', command: 'node', args: ['${workspaceFolder}/server.js', '${cwd}', '${env:SECRET}'], cwd: '${workspaceFolder}/tools', env: { WORKSPACE: '${cwd}' } }, '/srv/space dir')
  assert.equal(command, "cd '/srv/space dir/tools' && exec env -- WORKSPACE='/srv/space dir' 'node' '/srv/space dir/server.js' '/srv/space dir' '${env:SECRET}'")
})

test('installed DSH SDK connects and calls a server through SSH stream transport', { skip: !process.env.DSH_MCP_BRIDGE }, async () => {
  const bridgePath = process.env.DSH_MCP_BRIDGE
  const require = createRequire(bridgePath)
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href)
  const { createMcpToolDefinition } = await import(pathToFileURL(bridgePath).href)
  const registrations = new Map()
  const readable = new PassThrough()
  const stream = { readable, close() { readable.destroy() } }
  let input = ''
  stream.writable = new Writable({ write(chunk, _encoding, done) {
    input += chunk.toString()
    let newline
    while ((newline = input.indexOf('\n')) !== -1) {
      const request = JSON.parse(input.slice(0, newline))
      input = input.slice(newline + 1)
      let result
      if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test-server', version: '1' } }
      else if (request.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
      else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: request.params.arguments.text }] }
      if (result) queueMicrotask(() => readable.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'))
      else if (request.id !== undefined) queueMicrotask(() => readable.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'))
    }
    done()
  } })
  const agent = { ctx: { tools: { register(definition) { registrations.set(definition.name, definition); return () => registrations.delete(definition.name) } }, get: () => undefined } }
  const binding = { pool: { openExecChannel: async () => stream }, ws: '/srv/project' }
  const dispose = await installRemoteMcpServers({ agent, servers: [{ serverName: 'files', transport: 'stdio', command: 'node' }], resolveBinding: async () => binding, sdk: { Client, createMcpToolDefinition } })
  try {
    const result = await registrations.get('mcp__files__echo').execute({ text: 'actual SDK' }, {})
    assert.deepEqual(result, { content: [{ type: 'text', text: 'actual SDK' }] })
  } finally { await dispose() }
})
