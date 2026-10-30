import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { shq } from './paths.js'

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

export function remoteMcpToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && joined.length <= 64) return joined
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

function string(value, label) {
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError(`${label} must be a string without NUL bytes`)
  return value
}

/** Build a POSIX remote command. Every configured value is a literal shell argument. */
export function remoteMcpCommand(config, root) {
  if (config?.transport !== 'stdio') throw new Error('remote MCP currently supports stdio only; HTTP requires a remote HTTP transport')
  string(root, 'remote workspace')
  const expand = (value, label) => string(value, label).replace(/\$\{(?:workspaceFolder|cwd)\}/g, () => root)
  const command = expand(config.command, 'MCP command')
  if (!command) throw new Error('MCP command must not be empty')
  if (!Array.isArray(config.args ?? [])) throw new TypeError('MCP args must be an array')
  const args = (config.args ?? []).map((arg) => expand(arg, 'MCP argument'))
  const cwd = path.posix.resolve(root, expand(config.cwd ?? '.', 'MCP cwd'))
  if (!path.posix.isAbsolute(root)) throw new Error('remote MCP requires an absolute POSIX workspace')
  if (config.env !== undefined && (!config.env || typeof config.env !== 'object' || Array.isArray(config.env))) throw new TypeError('MCP env must be an object')
  const env = Object.entries(config.env ?? {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid MCP environment variable: ${key}`)
    return `${key}=${shq(expand(value, 'MCP environment value'))}`
  })
  return `cd ${shq(cwd)} && exec env -- ${env.join(' ')}${env.length ? ' ' : ''}${[command, ...args].map(shq).join(' ')}`
}

/** MCP newline-delimited JSON transport over a pool-owned SSH command channel. */
export class RemoteMcpStdioTransport {
  constructor(pool, command, { maxMessageBytes = MAX_MESSAGE_BYTES } = {}) {
    this.pool = pool
    this.command = command
    this.maxMessageBytes = maxMessageBytes
    this.closed = false
    this.started = false
    this.buffer = Buffer.alloc(0)
  }

  async start() {
    if (this.closed) throw new Error('remote MCP transport is closed')
    if (this.started) throw new Error('remote MCP transport already started')
    this.started = true
    const channel = await this.pool.openExecChannel(this.command)
    this.channel = channel
    if (this.closed) { channel.close?.(); channel.destroy?.(); throw new Error('remote MCP transport closed during startup') }
    this.readable = channel.readable && typeof channel.readable.on === 'function' ? channel.readable : channel
    this.writable = channel.writable && typeof channel.writable.write === 'function' ? channel.writable : channel
    this.onData = (chunk) => {
      try {
        this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
        let newline
        while ((newline = this.buffer.indexOf(10)) !== -1) {
          if (newline > this.maxMessageBytes) throw new Error('remote MCP message exceeds byte limit')
          const line = this.buffer.subarray(0, newline).toString('utf8')
          this.buffer = this.buffer.subarray(newline + 1)
          if (line.trim()) {
            const message = JSON.parse(line)
            this.onmessage?.(message)
          }
        }
        if (this.buffer.length > this.maxMessageBytes) throw new Error('remote MCP message exceeds byte limit')
      } catch (error) { this.onerror?.(error); void this.close() }
    }
    this.onError = (error) => { this.onerror?.(error); void this.close() }
    this.onEnd = () => { void this.close() }
    this.readable.on('data', this.onData)
    this.readable.on('error', this.onError)
    this.readable.on('end', this.onEnd)
    this.readable.on('close', this.onEnd)
    this.onStderr = () => {}
    channel.stderr?.on('data', this.onStderr)
    if (channel.done) channel.done.then(this.onEnd, this.onError)
  }

  async send(message) {
    if (this.closed || !this.writable) throw new Error('remote MCP transport is disconnected')
    const line = JSON.stringify(message) + '\n'
    if (Buffer.byteLength(line) > this.maxMessageBytes) throw new Error('remote MCP message exceeds byte limit')
    await new Promise((resolve, reject) => {
      try { this.writable.write(line, (error) => error ? reject(error) : resolve()) } catch (error) { reject(error) }
    })
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.readable?.off('data', this.onData)
    this.readable?.off('end', this.onEnd)
    this.readable?.off('close', this.onEnd)
    // Keep the error listener to absorb late shutdown errors.
    this.channel?.stderr?.off('data', this.onStderr)
    this.channel?.close?.()
    this.channel?.destroy?.()
    this.buffer = Buffer.alloc(0)
    this.onclose?.()
  }
}

async function loadSdk() {
  try {
    const require = createRequire(import.meta.url)
    const bridgePath = require.resolve('@deepseek-ai/dsh-mcp-client')
    const bridgeRequire = createRequire(bridgePath)
    const [bridge, sdk] = await Promise.all([
      import(pathToFileURL(bridgePath).href),
      import(pathToFileURL(bridgeRequire.resolve('@modelcontextprotocol/client')).href),
    ])
    if (typeof bridge.createMcpToolDefinition !== 'function') throw new Error('createMcpToolDefinition is unavailable')
    return { Client: sdk.Client, createMcpToolDefinition: bridge.createMcpToolDefinition }
  } catch (cause) {
    throw new Error('remote MCP requires DSH mcp-client with createMcpToolDefinition and its MCP SDK', { cause })
  }
}

/**
 * Install explicitly supplied, approved remote stdio configs on one Agent.
 * Caller owns config discovery/authorization and awaits installation before exposing tools.
 * Does not load profile plugins, edit config, or execute any local server command.
 * Returns an async disposer; pass the Agent lifetime signal to cancel pending startup too.
 */
export async function installRemoteMcpServers({ agent, servers, resolveBinding, signal, sdk, startupTimeoutMs = 30_000 }) {
  const ctx = agent?.ctx
  if (!ctx?.tools?.register || typeof resolveBinding !== 'function') throw new TypeError('remote MCP requires an Agent tool scope and binding resolver')
  if (!Array.isArray(servers)) throw new TypeError('remote MCP servers must be an array')
  const names = new Set()
  for (const config of servers) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(config?.serverName || '') || names.has(config.serverName)) throw new Error('remote MCP server names must be valid and unique within an Agent')
    names.add(config.serverName)
    if (config.transport !== 'stdio') throw new Error('remote MCP currently supports stdio only; HTTP requires a remote HTTP transport')
    if (config.maxInstructionBytes !== undefined && (!Number.isSafeInteger(config.maxInstructionBytes) || config.maxInstructionBytes <= 0)) throw new Error('invalid MCP instruction byte limit')
    if (config.toolCallTimeoutMs !== undefined && (!Number.isFinite(config.toolCallTimeoutMs) || config.toolCallTimeoutMs <= 0)) throw new Error('invalid MCP tool call timeout')
  }
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0) throw new Error('invalid MCP startup timeout')
  const releases = []
  const connections = []
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    signal?.removeEventListener('abort', onAbort)
    for (const release of releases.reverse()) { try { release?.() } catch {} }
    await Promise.allSettled(connections.map(({ client, transport }) => Promise.resolve().then(() => client.close()).finally(() => transport.close())))
  }
  const onAbort = () => { void dispose() }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    signal?.throwIfAborted()
    if (!servers.length) return dispose
    const bridge = sdk ?? await loadSdk()
    const binding = await resolveBinding()
    if (!binding?.pool?.openExecChannel || !binding.ws) throw new Error('remote MCP requires a bound SSH pool and workspace')
    const commands = servers.map((config) => remoteMcpCommand(config, binding.ws))
    const assertCurrent = async () => {
      if (disposed) throw new Error('remote MCP Agent scope is disposed')
      const current = await resolveBinding()
      if (current?.pool !== binding.pool || current?.ws !== binding.ws) throw new Error('remote MCP workspace binding changed; recreate the Agent')
    }
    for (let index = 0; index < servers.length; index += 1) {
      await assertCurrent()
      const config = servers[index]
      const transport = new RemoteMcpStdioTransport(binding.pool, commands[index])
      const client = new bridge.Client({ name: 'dsh-remote-mcp', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
      connections.push({ client, transport })
      const timeout = config.toolCallTimeoutMs ?? 60_000
      let timer
      let abort
      const cancelled = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`remote MCP ${config.serverName} startup timed out`)), startupTimeoutMs)
        abort = () => reject(signal.reason ?? new Error('remote MCP startup aborted'))
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
      let listed
      try {
        listed = await Promise.race([Promise.resolve().then(async () => {
          await client.connect(transport)
          return client.getServerCapabilities()?.tools === undefined ? { tools: [] } : await client.listTools(undefined, { timeout })
        }), cancelled])
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      await assertCurrent()
      const definitions = new Map()
      for (const tool of listed.tools) {
        const name = remoteMcpToolName(config.serverName, tool.name)
        if (definitions.has(name)) throw new Error(`remote MCP server listed duplicate tool: ${tool.name}`)
        definitions.set(name, bridge.createMcpToolDefinition(ctx, {
          name, rawName: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema, taskRequired: tool.execution?.taskSupport === 'required',
          call: async (args, exec) => {
            await assertCurrent()
            if (transport.closed) throw new Error('remote MCP transport is disconnected; recreate the Agent')
            return client.callTool({ name: tool.name, arguments: args }, { signal: exec.signal, timeout, toolDefinition: tool })
          },
        }))
      }
      for (const definition of definitions.values()) releases.push(ctx.tools.register(definition))
      const resources = typeof ctx.get === 'function' ? ctx.get('mcpResources') : undefined
      if (resources?.register) releases.push(resources.register(config.serverName, { request: async (request, exec) => {
        await assertCurrent()
        if (transport.closed) throw new Error('remote MCP transport is disconnected; recreate the Agent')
        const options = { signal: exec.signal, timeout }
        switch (request.method) {
          case 'resources/list': return client.listResources(request.cursor === undefined ? undefined : { cursor: request.cursor }, options)
          case 'resources/templates/list': return client.listResourceTemplates(request.cursor === undefined ? undefined : { cursor: request.cursor }, options)
          case 'resources/read': return client.readResource({ uri: request.uri }, options)
          default: throw new Error(`unsupported MCP resource method: ${request.method}`)
        }
      } }))
      const instructions = client.getInstructions?.()?.trimEnd() ?? ''
      if (Buffer.byteLength(instructions) > (config.maxInstructionBytes ?? 64 * 1024)) throw new Error('remote MCP server instructions exceed byte limit')
      const prompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
      if (instructions && prompt?.section) releases.push(prompt.section({ name: `mcp:${config.serverName}`, order: prompt.getSectionOrder('MCP_SERVERS'), interpolate: false, text: () => disposed || transport.closed ? '' : `### MCP server: ${config.serverName}\n\n${instructions}` }))
    }
    return dispose
  } catch (error) { await dispose(); throw error }
}
