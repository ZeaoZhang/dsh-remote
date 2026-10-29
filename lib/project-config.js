import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'

export const REMOTE_PROJECT_SKILL_PROVIDER = 'dsh-remote-project'
export const PROJECT_SKILL_REFRESH_MS = 30_000
export const PROJECT_SKILL_MAX_BYTES = 128 * 1024

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MANIFEST_SCHEMA_VERSION = 1
export const PROJECT_CONFIG_STATUS = Object.freeze({
  state: 'profile-scoped-only',
  reason: 'DSH 0.2.1-rc.3 ConfigEditor writes/reconciles profile patches; no project/Agent config overlay provider is available.',
})
export const PROJECT_PLUGIN_STATUS = Object.freeze({
  state: 'unsupported',
  reason: 'The DSH Loader enables profile-declared plugins only; compatibility exemptions are not project execution approvals.',
})

export function projectConfigCachePath(dshHome, machineId, remoteRoot, remoteWorkspacesRoot) {
  const home = realpathSync(path.resolve(dshHome))
  const workspaces = realpathSync(path.resolve(remoteWorkspacesRoot))
  const key = createHash('sha256')
    .update(`${String(machineId || '')}\0${String(remoteRoot || '')}`)
    .digest('hex')
    .slice(0, 32)
  const parent = path.join(home, 'remote-project-config')
  const target = path.join(parent, key)
  for (const candidate of [parent, target]) {
    try {
      const info = lstatSync(candidate)
      if (info.isSymbolicLink()) throw new Error('project config cache path may not contain symlinks')
      if (!info.isDirectory()) throw new Error('project config cache path component is not a directory')
      if ((info.mode & 0o077) !== 0) throw new Error('project config cache directories must be owner-only')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  const relative = path.relative(workspaces, target)
  const insideMirrorRegistry = relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  if (insideMirrorRegistry) throw new Error('project config cache must be physically outside remote-workspaces')
  return target
}

export function parseRemoteSkillDocument(text) {
  const raw = String(text ?? '')
  const lines = raw.split('\n')
  if (lines.length < 3 || lines[0].replace(/\r$/, '') !== '---') return null
  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].replace(/\r$/, '') === '---') { close = index; break }
  }
  if (close < 0) return null
  const data = parse(lines.slice(1, close).join('\n'))
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  for (const [legacy, canonical] of [
    ['disableModelInvocation', 'disable-model-invocation'],
    ['modelInvocable', 'disable-model-invocation'],
    ['userInvocable', 'user-invocable'],
  ]) {
    if (Object.hasOwn(data, legacy)) throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
  }
  const name = typeof data.name === 'string' && data.name.length > 0 ? data.name : undefined
  const description = typeof data.description === 'string' && data.description.length > 0 ? data.description : undefined
  if (!name || !SKILL_NAME.test(name)) throw new Error('frontmatter requires a valid kebab-case skill name')
  if (!description) throw new Error('frontmatter requires a non-empty description')
  const booleanField = (key) => {
    const value = data[key]
    if (value === undefined) return undefined
    if (typeof value === 'boolean') return value
    if (value === 1 || value === '1') return true
    if (value === 0 || value === '0') return false
    if (typeof value === 'string') {
      switch (value.toLowerCase()) {
        case 'true': case 'yes': case 'on': return true
        case 'false': case 'no': case 'off': return false
      }
    }
    throw new TypeError(`frontmatter field "${key}" must be a boolean`)
  }
  const disableModelInvocation = booleanField('disable-model-invocation')
  const userInvocable = booleanField('user-invocable')
  const metadata = typeof data.metadata === 'object' && data.metadata !== null && !Array.isArray(data.metadata)
    ? data.metadata
    : undefined
  const body = lines.slice(close + 1).join('\n').trim()
  return {
    name,
    description,
    ...(typeof data.whenToUse === 'string' && data.whenToUse.length > 0 ? { whenToUse: data.whenToUse } : {}),
    invocation: {
      modelInvocable: disableModelInvocation !== true,
      userInvocable: userInvocable !== false,
    },
    ...(metadata === undefined ? {} : { metadata }),
    content: body,
  }
}

function isWithinRemoteRoot(root, candidate) {
  const relative = path.posix.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative))
}

function validateManifest(remoteRoot, manifest) {
  if (!manifest || typeof manifest !== 'object' || manifest.root !== remoteRoot || !Array.isArray(manifest.entries)
    || typeof manifest.complete !== 'boolean' || !Array.isArray(manifest.diagnostics)
    || typeof manifest.snapshotVersion !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.snapshotVersion)) {
    throw new Error('remote project-skill manifest is invalid or belongs to a different workspace')
  }
  if (manifest.entries.length > 64) throw new Error('remote project-skill manifest exceeds the entry limit')
  let total = 0
  const paths = new Set()
  for (const entry of manifest.entries) {
    if (typeof entry?.path !== 'string' || !path.posix.isAbsolute(entry.path) || !isWithinRemoteRoot(remoteRoot, entry.path)) {
      throw new Error('remote project-skill manifest contains a path outside the workspace')
    }
    const relative = path.posix.relative(remoteRoot, entry.path)
    const segments = relative.split('/')
    const validRoot = (segments[0] === '.dsh' || segments[0] === '.agents') && segments[1] === 'skills'
    if (!validRoot || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error('remote project-skill manifest contains an invalid relative path')
    }
    const expectedSource = segments[0] === '.dsh' ? 'project-dsh' : 'project-agents'
    const expectedRank = segments[0] === '.dsh' ? 100 : 200
    const expectedDirectory = path.posix.dirname(entry.path)
    const validShape = (segments.length === 3 && segments[2].toLowerCase().endsWith('.md'))
      || (segments.length === 4 && segments[2] !== '.' && segments[3] === 'SKILL.md')
    if (!validShape || entry.source !== expectedSource || entry.rank !== expectedRank || entry.directory !== expectedDirectory
      || typeof entry.content !== 'string' || Buffer.byteLength(entry.content, 'utf8') !== entry.size
      || !Number.isInteger(entry.size) || entry.size < 0 || entry.size > PROJECT_SKILL_MAX_BYTES
      || !Number.isFinite(entry.mtimeMs) || !/^[a-f0-9]{64}$/.test(entry.version || '')) {
      throw new Error('remote project-skill manifest entry failed validation')
    }
    total += entry.size
    if (total > 2 * 1024 * 1024) throw new Error('remote project-skill manifest exceeds the total byte limit')
    if (paths.has(entry.path)) throw new Error('remote project-skill manifest contains duplicate paths')
    paths.add(entry.path)
  }
  return manifest
}

function summarizeManifest(manifest) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    root: manifest.root,
    snapshotVersion: manifest.snapshotVersion,
    complete: manifest.complete,
    updatedAt: new Date().toISOString(),
    projectConfig: PROJECT_CONFIG_STATUS,
    pluginDeclarations: PROJECT_PLUGIN_STATUS,
    diagnostics: Array.isArray(manifest.diagnostics) ? manifest.diagnostics.slice(0, 128) : [],
    entries: manifest.entries.map(({ path: filePath, directory, source, rank, size, mtimeMs, version, content }) => {
      const base = { path: filePath, directory, source, rank, size, mtimeMs, version }
      try {
        const skill = parseRemoteSkillDocument(content)
        return skill === null ? { ...base, invalid: true } : {
          ...base,
          name: skill.name,
          description: skill.description,
          ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
          invocation: skill.invocation,
          ...(skill.metadata === undefined ? {} : { metadata: skill.metadata }),
        }
      } catch (error) {
        return { ...base, invalid: true, diagnostic: String(error?.message || error).slice(0, 200) }
      }
    }),
  }
}

export async function writeProjectConfigSnapshot(localRoot, manifest, fsApi = { mkdir, lstat, writeFile, rename, unlink }) {
  const root = path.resolve(localRoot)
  const snapshot = summarizeManifest(manifest)
  await fsApi.mkdir(root, { recursive: true, mode: 0o700 })
  const rootInfo = await fsApi.lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('project config manifest root is not a real directory')
  if ((rootInfo.mode & 0o077) !== 0) throw new Error('project config manifest directory must be owner-only')
  const target = path.join(root, 'manifest.json')
  try {
    const targetInfo = await fsApi.lstat(target)
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) throw new Error('project config manifest target is not a regular file')
    if ((targetInfo.mode & 0o077) !== 0) throw new Error('project config manifest file must be owner-only')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const temp = path.join(root, `.manifest-${randomUUID()}.tmp`)
  try {
    await fsApi.writeFile(temp, JSON.stringify(snapshot), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await fsApi.rename(temp, target)
  } catch (error) {
    try { await fsApi.unlink(temp) } catch { /* best effort */ }
    throw error
  }
  return { path: target, snapshot }
}

async function readCachedSnapshot(localRoot, remoteRoot) {
  try {
    const snapshot = JSON.parse(await readFile(path.join(localRoot, 'manifest.json'), 'utf8'))
    if (snapshot.schemaVersion !== MANIFEST_SCHEMA_VERSION || snapshot.root !== remoteRoot || !Array.isArray(snapshot.entries)) return null
    return snapshot
  } catch {
    return null
  }
}

function candidateFrom(entry) {
  if (entry.invalid) return null
  return {
    name: entry.name,
    description: entry.description,
    ...(entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse }),
    invocation: entry.invocation,
    source: entry.source,
    provider: REMOTE_PROJECT_SKILL_PROVIDER,
    rank: entry.rank,
    locator: { path: entry.path, directory: entry.directory, version: entry.version },
    resourceBase: { kind: 'directory', path: entry.directory },
    path: entry.path,
    ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
  }
}

function mirrorSuppressionCandidates(hostSkills, remoteNames, mirrorRoot) {
  if (typeof mirrorRoot !== 'string') return []
  const root = path.resolve(mirrorRoot)
  const suppressed = []
  for (const skill of hostSkills || []) {
    if (!['project-dsh', 'project-agents'].includes(skill?.source) || typeof skill.path !== 'string' || !SKILL_NAME.test(skill.name || '')) continue
    const localPath = path.resolve(skill.path)
    const relative = path.relative(root, localPath)
    const inside = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    if (!inside || remoteNames.has(skill.name)) continue
    suppressed.push({
      name: skill.name,
      description: 'A local mirror project skill is disabled in transparent mode because no matching remote skill was discovered.',
      invocation: { modelInvocable: false, userInvocable: false },
      source: 'remote-mirror-suppressed',
      provider: REMOTE_PROJECT_SKILL_PROVIDER,
      rank: Number.isFinite(skill.rank) ? skill.rank : 100,
      locator: { suppressed: true },
      path: skill.path,
    })
  }
  return suppressed
}

export function createRemoteProjectSkillProvider({ resolveBinding, getHelper, localConfigRoot, mirrorRoot, snapshotHostSkills, initialHostSkills = [], initialHostComplete = true, logger = console, now = Date.now }) {
  if (typeof resolveBinding !== 'function' || typeof getHelper !== 'function' || typeof localConfigRoot !== 'string') {
    throw new TypeError('remote project skill provider requires binding, helper, and snapshot resolvers')
  }
  let control
  let cached
  let lastRefresh = 0
  let lastHostSnapshot = { skills: initialHostSkills, complete: initialHostComplete === true }
  let disposed = false

  async function collectHostSnapshot(signal) {
    if (typeof snapshotHostSkills !== 'function' || typeof mirrorRoot !== 'string') {
      // Without a host snapshot reader we cannot classify local mirror
      // candidates at all, so suppression must not claim authority.
      return { skills: [], complete: false }
    }
    let current
    try {
      current = await snapshotHostSkills({ cwd: mirrorRoot, signal })
    } catch (error) {
      if (signal?.aborted) throw error
      logger?.warn?.(`host project-skill snapshot failed: ${String(error?.message || error)}`)
      return lastHostSnapshot ? { ...lastHostSnapshot, complete: false } : { skills: [], complete: false }
    }
    if (!current || !Array.isArray(current.skills) || typeof current.complete !== 'boolean') {
      return lastHostSnapshot ? { ...lastHostSnapshot, complete: false } : { skills: [], complete: false }
    }
    if (current.complete) lastHostSnapshot = current
    if (current.complete) return current
    // Keep whatever the fresh (partial) snapshot did discover — it is strictly
    // better for suppression classification than replaying only the last good
    // snapshot — while marking the merged view incomplete.
    const merged = new Map()
    for (const skill of lastHostSnapshot?.skills || []) merged.set(skill.name, skill)
    for (const skill of current.skills) merged.set(skill.name, skill)
    return { skills: [...merged.values()], complete: false }
  }

  function hostSnapshotVersion(snapshot) {
    const entries = (snapshot?.skills || []).filter((skill) => skill?.source === 'project-dsh' || skill?.source === 'project-agents')
      .map((skill) => ({ name: skill.name, source: skill.source, path: skill.path }))
    return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
  }

  async function fetchManifest(signal) {
    signal?.throwIfAborted()
    const hostSnapshot = await collectHostSnapshot(signal)
    const binding = await resolveBinding(signal)
    if (!binding?.bound || !binding.ws) throw new Error('remote project skills require a valid remote workspace binding')
    const helper = await getHelper(binding, signal)
    const manifest = validateManifest(binding.ws, await helper.rpc.request('project_skills_manifest', {}, { signal }))
    const summaries = summarizeManifest(manifest)
    const hostVersion = hostSnapshotVersion(hostSnapshot)
    const revision = `${summaries.snapshotVersion}:${hostVersion}`
    const changed = !cached || cached.revision !== revision
    if (manifest.complete) {
      const stored = await writeProjectConfigSnapshot(localConfigRoot, manifest)
      cached = {
        root: binding.ws,
        snapshot: stored.snapshot,
        complete: hostSnapshot.complete,
        hostSkills: hostSnapshot.skills,
        hostComplete: hostSnapshot.complete,
        revision,
      }
    } else if (cached?.root === binding.ws) {
      cached = { ...cached, complete: false, hostSkills: hostSnapshot.skills, hostComplete: hostSnapshot.complete, revision }
    } else {
      cached = {
        root: binding.ws,
        snapshot: summaries,
        complete: false,
        hostSkills: hostSnapshot.skills,
        hostComplete: hostSnapshot.complete,
        revision,
      }
    }
    lastRefresh = now()
    return { binding, helper, manifest, changed, complete: cached.complete }
  }

  async function refreshIfStale(signal, force = false) {
    if (disposed) return false
    if (!force && cached && now() - lastRefresh < PROJECT_SKILL_REFRESH_MS) return false
    try {
      const result = await fetchManifest(signal)
      if (result.changed) control?.invalidate()
      return result.changed
    } catch (error) {
      if (signal?.aborted) throw error
      lastRefresh = now()
      try {
        const hostSnapshot = await collectHostSnapshot(signal)
        const binding = await resolveBinding(signal)
        if (!cached && binding?.ws) {
          const saved = await readCachedSnapshot(localConfigRoot, binding.ws)
          if (saved) {
            cached = {
              root: binding.ws,
              snapshot: saved,
              complete: false,
              hostSkills: hostSnapshot.skills,
              hostComplete: hostSnapshot.complete,
              revision: saved.snapshotVersion,
            }
          } else {
            cached = {
              root: binding.ws,
              snapshot: { schemaVersion: MANIFEST_SCHEMA_VERSION, root: binding.ws, snapshotVersion: '', entries: [] },
              complete: false,
              hostSkills: hostSnapshot.skills,
              hostComplete: hostSnapshot.complete,
              revision: `offline:${hostSnapshotVersion(hostSnapshot)}`,
            }
          }
        }
        if (cached && binding?.ws === cached.root) {
          cached = {
            ...cached,
            complete: false,
            hostSkills: hostSnapshot.skills,
            hostComplete: hostSnapshot.complete,
          }
        }
      } catch { /* keep the previous manifest, if any */ }
      logger?.warn?.(`remote project-skill manifest refresh failed: ${String(error?.message || error)}`)
      return false
    }
  }

  function invalidateCandidate(filePath) {
    if (!cached?.snapshot?.entries) return
    cached = {
      ...cached,
      complete: false,
      snapshot: {
        ...cached.snapshot,
        entries: cached.snapshot.entries.map((entry) => entry.path === filePath ? { ...entry, invalid: true } : entry),
      },
    }
  }

  async function readCandidate(helper, candidate, signal) {
    return helper.rpc.request('project_skill_read', {
      path: candidate.locator.path,
      expectedVersion: candidate.locator.version,
      maxBytes: PROJECT_SKILL_MAX_BYTES,
    }, { signal })
  }

  const provider = {
    name: REMOTE_PROJECT_SKILL_PROVIDER,
    async list(options = {}) {
      if (!cached || now() - lastRefresh >= PROJECT_SKILL_REFRESH_MS) await refreshIfStale(options.signal)
      const remoteCandidates = (cached?.snapshot?.entries || []).map(candidateFrom).filter(Boolean)
      const remoteNames = new Set(remoteCandidates.map((candidate) => candidate.name))
      const suppressed = mirrorSuppressionCandidates(cached?.hostSkills, remoteNames, mirrorRoot)
      return {
        candidates: [...remoteCandidates, ...suppressed],
        complete: cached?.complete === true && cached?.hostComplete !== false,
      }
    },
    async get(candidate, options = {}) {
      if (candidate?.locator?.suppressed) return undefined
      if (!candidate?.locator?.path || !candidate.locator.version) return undefined
      const binding = await resolveBinding(options.signal)
      if (!binding?.bound || !binding.ws || !isWithinRemoteRoot(binding.ws, candidate.locator.path)) {
        throw new Error('remote project skill path is outside its workspace binding')
      }
      const helper = await getHelper(binding, options.signal)
      let loaded
      try {
        loaded = await readCandidate(helper, candidate, options.signal)
      } catch (error) {
        const refreshCodes = new Set(['REMOTE_STALE_CONFIG', 'REMOTE_NOT_FOUND', 'ENOENT'])
        const invalidateCodes = new Set([
          'REMOTE_CONFIG_SYMLINK', 'REMOTE_CONFIG_PATH_DENIED', 'REMOTE_PATH_DENIED',
          'REMOTE_NOT_FILE', 'REMOTE_CONFIG_NOT_UTF8', 'REMOTE_CONTENT_TOO_LARGE',
        ])
        if (invalidateCodes.has(error?.code)) {
          invalidateCandidate(candidate.locator.path)
          control?.invalidate()
          return undefined
        }
        if (!refreshCodes.has(error?.code)) throw error
        control?.invalidate()
        await refreshIfStale(options.signal, true)
        const replacement = (cached?.snapshot?.entries || []).map(candidateFrom).find((entry) => entry?.name === candidate.name)
        if (!replacement || (replacement.locator.path === candidate.locator.path && replacement.locator.version === candidate.locator.version)) {
          invalidateCandidate(candidate.locator.path)
          control?.invalidate()
          return undefined
        }
        candidate = replacement
        try {
          loaded = await readCandidate(helper, replacement, options.signal)
        } catch (retryError) {
          if (!invalidateCodes.has(retryError?.code) && !refreshCodes.has(retryError?.code)) throw retryError
          invalidateCandidate(candidate.locator.path)
          control?.invalidate()
          return undefined
        }
      }
      const parsed = parseRemoteSkillDocument(loaded.text)
      if (!parsed || parsed.name !== candidate.name) {
        invalidateCandidate(candidate.locator.path)
        control?.invalidate()
        return undefined
      }
      return {
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        invocation: parsed.invocation,
        source: candidate.source,
        provider: REMOTE_PROJECT_SKILL_PROVIDER,
        resourceBase: { kind: 'directory', path: loaded.directory },
        path: loaded.path,
        ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
        content: parsed.content,
      }
    },
  }

  return {
    provider,
    refreshIfStale,
    markDirty() { lastRefresh = 0 },
    dispose() { disposed = true },
    bindControl(value) { control = value },
  }
}
