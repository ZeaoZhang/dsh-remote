import path from 'node:path'
import { shq } from './paths.js'
import { installRemoteMcpServers } from './remote-mcp.js'

export const REMOTE_MCP_CONFIG_MAX_BYTES = 128 * 1024
export const REMOTE_MCP_CONFIG_FORMAT = 'mcpServers object; user $DSH_HOME/mcp.json (default ~/.dsh/mcp.json), project .mcp.json, then .dsh/mcp.json; later server names override earlier ones; disabled:true removes a server; ${workspaceFolder}/${cwd} expand to the remote workspace; ${env:NAME} interpolation and envFile are unsupported'

// Reads occur on the SSH host. No config path or server command is opened locally.
const READ_CONFIG_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[1];
const home = process.env.HOME;
if (!home && !process.env.DSH_HOME) throw new Error('remote HOME/DSH_HOME unavailable');
const paths = [...new Set([
  path.join(process.env.DSH_HOME || path.join(home, '.dsh'), 'mcp.json'),
  path.join(root, '.mcp.json'), path.join(root, '.dsh', 'mcp.json'),
])];
const files = [];
for (const file of paths) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 131072) throw new Error('config must be a regular file of at most 131072 bytes');
    const buffer = Buffer.alloc(131073);
    let size = 0, count;
    while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null))) size += count;
    if (size > 131072) throw new Error('config exceeds 131072 bytes');
    files.push({ path: file, text: buffer.subarray(0, size).toString('utf8') });
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read MCP config ' + file + ': ' + error.message);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
process.stdout.write(JSON.stringify({ root, files }));
`

export function parseRemoteMcpConfigs(snapshot, remoteRoot) {
  if (snapshot?.root !== remoteRoot || !Array.isArray(snapshot.files) || snapshot.files.length > 3) throw new Error('invalid remote MCP config snapshot')
  const merged = new Map()
  const sources = []
  for (const file of snapshot.files) {
    if (typeof file?.path !== 'string' || !path.posix.isAbsolute(file.path) || typeof file.text !== 'string' || Buffer.byteLength(file.text) > REMOTE_MCP_CONFIG_MAX_BYTES) throw new Error('invalid remote MCP config file')
    let parsed
    try { parsed = JSON.parse(file.text) } catch { throw new Error(`Invalid JSON in remote MCP config ${file.path}`) }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) throw new Error(`Remote MCP config ${file.path} requires an mcpServers object`)
    sources.push(file.path)
    for (const [serverName, entry] of Object.entries(parsed.mcpServers)) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName) || !entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Invalid server declaration in remote MCP config ${file.path}`)
      if (entry.disabled === true) { merged.delete(serverName); continue }
      const transport = entry.transport ?? entry.type ?? (entry.url ? 'streamable-http' : 'stdio')
      if (transport !== 'stdio') throw new Error(`Remote MCP server ${serverName} in ${file.path} uses ${transport}; remote HTTP transport is not implemented`)
      merged.set(serverName, {
        serverName, transport,
        command: entry.command,
        ...(entry.args === undefined ? {} : { args: entry.args }),
        ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
        ...(entry.env === undefined ? {} : { env: entry.env }),
        ...(entry.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: entry.toolCallTimeoutMs }),
        ...(entry.maxInstructionBytes === undefined ? {} : { maxInstructionBytes: entry.maxInstructionBytes }),
      })
      if (merged.size > 64) throw new Error('remote MCP config exceeds 64 servers')
    }
  }
  return { servers: [...merged.values()], sources }
}

export async function discoverRemoteMcpServers({ binding, signal, nodeCommand = 'node' }) {
  if (!binding?.pool?.exec || typeof binding.ws !== 'string' || !path.posix.isAbsolute(binding.ws)) throw new Error('remote MCP discovery requires an SSH pool and POSIX workspace')
  if (typeof nodeCommand !== 'string' || !nodeCommand || nodeCommand.includes('\0')) throw new Error('invalid remote Node command')
  const result = await binding.pool.exec(`${shq(nodeCommand)} -e ${shq(READ_CONFIG_SCRIPT)} ${shq(binding.ws)}`, { signal, timeoutMs: 15_000 })
  if (result.code !== 0) throw new Error(`Remote MCP config discovery failed: ${String(result.stderr || 'remote Node is unavailable').slice(0, 1000)}`)
  if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 4 * 1024 * 1024) throw new Error('remote MCP config discovery response exceeds byte limit')
  let snapshot
  try { snapshot = JSON.parse(result.stdout) } catch { throw new Error('invalid remote MCP config discovery response') }
  return parseRemoteMcpConfigs(snapshot, binding.ws)
}

export function formatRemoteMcpStatus(state) {
  return {
    servers: (state?.servers ?? []).map(({ serverName, name, transport }) => ({ name: serverName ?? name, transport })),
    sources: [...(state?.sources ?? [])],
    format: state?.format ?? REMOTE_MCP_CONFIG_FORMAT,
  }
}

/** Discover and install remote configs, masking inherited local MCP capabilities in this Agent. */
export async function createRemoteMcpState({ agent, resolveBinding, signal, nodeCommand, sdk, startupTimeoutMs }) {
  const tools = agent?.ctx?.tools
  if (typeof tools?.view !== 'function' || typeof tools?.restrict !== 'function' || typeof tools?.get !== 'function' || typeof tools?.guard !== 'function') throw new Error('remote MCP requires scoped tool view, restriction, lookup, and guard APIs')
  const view = tools.view(agent)
  const inherited = [...view.restrictableNames].filter((name) => name.startsWith('mcp__'))
  const releaseMask = inherited.length ? tools.restrict({ deny: inherited }) : () => {}
  const ownedRemoteTools = new Map()
  const allowed = new Set()
  const resourceTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
  const releaseGuard = tools.guard((exec) => {
    if (exec.name.startsWith('mcp__') && (!ownedRemoteTools.has(exec.name) || tools.get(exec.name, exec.agent) !== ownedRemoteTools.get(exec.name))) return 'Local MCP tools are unavailable in this remote Agent'
    if (resourceTools.has(exec.name) && !allowed.has(exec.arguments?.server)) return `MCP server ${exec.arguments?.server} is not configured on this remote Agent`
  })
  let disposeServers
  let stopping
  const dispose = () => stopping ??= Promise.resolve().then(async () => {
    try { await disposeServers?.() } finally {
      releaseGuard()
      allowed.clear()
      ownedRemoteTools.clear()
      releaseMask()
      signal?.removeEventListener('abort', onAbort)
    }
  })
  const onAbort = () => { void dispose() }
  try {
    signal?.throwIfAborted()
    const binding = await resolveBinding()
    const { servers, sources } = await discoverRemoteMcpServers({ binding, signal, nodeCommand })
    for (const server of servers) allowed.add(server.serverName)
    if (servers.length && [...resourceTools].some((name) => tools.get(name, agent)) && !agent.ctx.get?.('mcpResources')?.register) throw new Error('remote MCP resources require a scoped mcpResources runtime')
    const initialOwnMcp = [...view.visible.keys()].filter((name) => name.startsWith('mcp__') && !view.restrictableNames.has(name))
    if (initialOwnMcp.length) throw new Error('remote MCP cannot replace MCP tools already registered in this Agent scope')
    const resolveConfiguredBinding = async () => {
      const current = await resolveBinding()
      if (current?.pool !== binding.pool || current?.ws !== binding.ws) throw new Error('remote MCP workspace binding changed; recreate the Agent')
      return current
    }
    disposeServers = await installRemoteMcpServers({ agent, servers, resolveBinding: resolveConfiguredBinding, signal, sdk, ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }) })
    for (const [name, definition] of tools.view(agent).visible) {
      if (name.startsWith('mcp__')) ownedRemoteTools.set(name, definition)
    }
    signal?.throwIfAborted()
    signal?.addEventListener('abort', onAbort, { once: true })
    return { servers: servers.map(({ serverName, transport }) => ({ serverName, transport })), sources, format: REMOTE_MCP_CONFIG_FORMAT, dispose }
  } catch (error) { await dispose(); throw error }
}

/**
 * Fail-closed remote MCP behaviour for a transparent Agent: when the server's
 * MCP configuration cannot be discovered or started, no MCP capability may
 * remain callable — inherited local servers must never stand in for the
 * host's. Masks every inherited `mcp__*` tool and guards the shared resource
 * tools; returns a disposer for Agent teardown.
 */
export function maskRemoteMcpCapabilities(agent) {
  const tools = agent?.ctx?.tools
  if (typeof tools?.view !== 'function' || typeof tools?.restrict !== 'function' || typeof tools?.get !== 'function' || typeof tools?.guard !== 'function') return () => {}
  const view = tools.view(agent)
  const inherited = [...view.restrictableNames].filter((name) => name.startsWith('mcp__'))
  const releaseMask = inherited.length ? tools.restrict({ deny: inherited }) : () => {}
  const resourceTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
  const releaseGuard = tools.guard((exec) => {
    const name = String(exec?.name || '')
    if (name.startsWith('mcp__')) return 'The remote host has no usable MCP configuration in this Agent; local MCP tools are unavailable'
    if (resourceTools.has(name)) return `MCP server ${exec?.arguments?.server} is not configured on this remote Agent`
  })
  let released = false
  return () => {
    if (released) return
    released = true
    try { releaseGuard() } finally { releaseMask() }
  }
}
