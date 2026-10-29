import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  createRemoteProjectSkillProvider,
  parseRemoteSkillDocument,
  projectConfigCachePath,
  writeProjectConfigSnapshot,
} from '../lib/project-config.js'

const root = '/srv/projects/remote-a'
const skillPath = `${root}/.dsh/skills/review/SKILL.md`
const skillDirectory = `${root}/.dsh/skills/review`
const binding = { bound: true, ws: root, machine: { id: 'machine-a' }, pool: {} }

function skillText(name = 'review', body = 'Read and assess the remote changes.') {
  return `---\nname: ${name}\ndescription: Review source\nwhenToUse: Before changing code\ndisable-model-invocation: false\nuser-invocable: true\nmetadata:\n  owner: project\n---\n${body}\n`
}

function entry(text = skillText(), version = createHash('sha256').update(text).digest('hex')) {
  return {
    path: skillPath,
    directory: skillDirectory,
    relative: '.dsh/skills/review/SKILL.md',
    source: 'project-dsh',
    rank: 100,
    size: Buffer.byteLength(text),
    mtimeMs: 123,
    version,
    content: text,
  }
}

function manifest(entries = [entry()], complete = true) {
  const snapshotVersion = createHash('sha256')
    .update(JSON.stringify(entries.map(({ path: filePath, source, size, mtimeMs, version }) => ({ path: filePath, source, size, mtimeMs, version }))))
    .digest('hex')
  return { root, snapshotVersion, complete, entries, diagnostics: [] }
}

function fixture(t, options = {}) {
  const localHome = mkdtempSync(path.join(tmpdir(), 'dsh-project-config-'))
  t.after(() => rmSync(localHome, { recursive: true, force: true }))
  const localConfigRoot = path.join(localHome, 'remote-project-config', 'workspace-a')
  const mirrorRoot = path.join(localHome, 'remote-workspaces', 'workspace-a')
  mkdirSync(mirrorRoot, { recursive: true })
  const requests = []
  let remoteManifest = options.manifest || manifest()
  let currentText = options.currentText || remoteManifest.entries[0]?.content || skillText()
  let staleOnce = false
  const helper = {
    rpc: {
      async request(op, payload) {
        requests.push({ op, payload })
        if (op === 'project_skills_manifest') return remoteManifest
        if (op === 'project_skill_read') {
          if (!remoteManifest.entries.some((entry) => entry.path === payload.path)) {
            const error = new Error('project skill no longer exists')
            error.code = 'ENOENT'
            throw error
          }
          const currentVersion = createHash('sha256').update(currentText).digest('hex')
          if (payload.expectedVersion !== currentVersion) {
            const error = new Error('project skill changed after manifest creation')
            error.code = 'REMOTE_STALE_CONFIG'
            if (options.onStale) {
              staleOnce = true
              remoteManifest = options.onStale(remoteManifest)
              currentText = remoteManifest.entries[0].content
            }
            throw error
          }
          return {
            path: payload.path,
            directory: skillDirectory,
            version: currentVersion,
            text: currentText,
          }
        }
        throw new Error(`unexpected helper operation: ${op}`)
      },
    },
  }
  const hostSkills = options.hostSkills || { complete: true, skills: [] }
  const state = createRemoteProjectSkillProvider({
    resolveBinding: async () => binding,
    getHelper: async () => helper,
    localConfigRoot,
    mirrorRoot,
    snapshotHostSkills: async () => hostSkills,
    logger: { warn() {} },
    now: () => 100000,
  })
  let invalidations = 0
  state.bindControl({ invalidate() { invalidations += 1 } })
  return { helper, hostSkills, invalidations: () => invalidations, localConfigRoot, localHome, manifest: () => remoteManifest, setManifest: (value) => { remoteManifest = value }, mirrorRoot, requests, state, staleOnce: () => staleOnce }
}

test('DSH skill frontmatter uses the host name, invocation, metadata, and body contract', () => {
  const parsed = parseRemoteSkillDocument(skillText())
  assert.equal(parsed.name, 'review')
  assert.equal(parsed.description, 'Review source')
  assert.deepEqual(parsed.invocation, { modelInvocable: true, userInvocable: true })
  assert.deepEqual(parsed.metadata, { owner: 'project' })
  assert.equal(parsed.content, 'Read and assess the remote changes.')
  assert.equal(parseRemoteSkillDocument('body without frontmatter'), null)
  assert.throws(() => parseRemoteSkillDocument('---\nname: Bad_Name\ndescription: x\n---\nbody'), /kebab-case/)
  assert.throws(() => parseRemoteSkillDocument('---\nname: valid\ndescription: x\nuser-invocable: maybe\n---\nbody'), /must be a boolean/)
})

test('remote skill provider is scoped, persists metadata only, and maps resources to the remote root', async (t) => {
  const localSkill = {
    name: 'stale-local',
    source: 'project-dsh',
    rank: 100,
    path: path.join('local-placeholder', '.dsh', 'skills', 'stale-local', 'SKILL.md'),
    description: 'Old local mirror copy',
  }
  const fixtureState = fixture(t, { hostSkills: { complete: true, skills: [localSkill] } })
  const observedLocal = { ...localSkill, path: path.join(fixtureState.mirrorRoot, '.dsh', 'skills', 'stale-local', 'SKILL.md') }
  fixtureState.hostSkills.skills[0] = observedLocal
  const listed = await fixtureState.state.provider.list({ cwd: fixtureState.mirrorRoot })
  assert.equal(listed.complete, true)
  assert.deepEqual(listed.candidates.map((candidate) => candidate.name), ['review', 'stale-local'])
  assert.deepEqual(listed.candidates[0].resourceBase, { kind: 'directory', path: skillDirectory })
  assert.deepEqual(listed.candidates[1].invocation, { modelInvocable: false, userInvocable: false })
  assert.equal(await fixtureState.state.provider.get(listed.candidates[1]), undefined)

  const skill = await fixtureState.state.provider.get(listed.candidates[0])
  assert.equal(skill.path, skillPath)
  assert.deepEqual(skill.resourceBase, { kind: 'directory', path: skillDirectory })
  assert.match(skill.content, /remote changes/)
  assert.equal(fixtureState.requests.filter(({ op }) => op === 'project_skill_read').length, 1)

  const saved = JSON.parse(readFileSync(path.join(fixtureState.localConfigRoot, 'manifest.json'), 'utf8'))
  assert.equal(saved.projectConfig.state, 'profile-scoped-only')
  assert.match(saved.projectConfig.reason, /ConfigEditor.*profile patches/)
  assert.equal(saved.pluginDeclarations.state, 'unsupported')
  assert.match(saved.pluginDeclarations.reason, /compatibility exemptions are not project execution approvals/)
  assert.equal(saved.entries[0].path, skillPath)
  assert.equal(JSON.stringify(saved).includes('Read and assess the remote changes.'), false)
  assert.equal(path.relative(fixtureState.localHome, fixtureState.localConfigRoot).startsWith('remote-project-config'), true)
})

test('remote skill refresh retries a stale file from the next manifest generation', async (t) => {
  const nextText = skillText('review', 'Use the refreshed remote policy.')
  const nextEntry = entry(nextText)
  const fixtureState = fixture(t, {
    currentText: nextText,
    onStale: () => manifest([nextEntry]),
  })
  const listed = await fixtureState.state.provider.list({ cwd: fixtureState.mirrorRoot })
  const loaded = await fixtureState.state.provider.get(listed.candidates[0])
  assert.equal(loaded.content, 'Use the refreshed remote policy.')
  assert.equal(fixtureState.requests.filter(({ op }) => op === 'project_skill_read').length, 2)
  assert.ok(fixtureState.invalidations() >= 1)
})

test('a deleted remote skill refreshes and removes the stale candidate', async (t) => {
  const state = fixture(t)
  const listed = await state.state.provider.list({ cwd: state.mirrorRoot })
  const candidate = listed.candidates.find((skill) => skill.name === 'review')
  assert.ok(candidate)
  state.setManifest(manifest([], true))

  const loaded = await state.state.provider.get(candidate)
  assert.equal(loaded, undefined)
  assert.equal(state.invalidations() > 0, true)
  assert.equal((await state.state.provider.list({ cwd: state.mirrorRoot })).candidates.some((skill) => skill.name === 'review'), false)
})


test('offline provider tombstones local mirror-only skills without loading their content', async (t) => {
  const localHome = mkdtempSync(path.join(tmpdir(), 'dsh-project-config-offline-'))
  t.after(() => rmSync(localHome, { recursive: true, force: true }))
  const mirrorRoot = path.join(localHome, 'remote-workspaces', 'workspace-a')
  const localSkill = {
    name: 'stale-local',
    description: 'Old mirror skill',
    source: 'project-dsh',
    rank: 100,
    path: path.join(mirrorRoot, '.dsh', 'skills', 'stale-local', 'SKILL.md'),
  }
  const state = createRemoteProjectSkillProvider({
    resolveBinding: async () => binding,
    getHelper: async () => { throw new Error('ssh unavailable') },
    localConfigRoot: path.join(localHome, 'remote-project-config', 'workspace-a'),
    mirrorRoot,
    snapshotHostSkills: async () => ({ skills: [localSkill], complete: true }),
    logger: { warn() {} },
  })
  state.bindControl({ invalidate() {} })
  const result = await state.provider.list({ cwd: mirrorRoot })
  assert.equal(result.complete, false)
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].name, 'stale-local')
  assert.deepEqual(result.candidates[0].invocation, { modelInvocable: false, userInvocable: false })
  assert.equal(await state.provider.get(result.candidates[0]), undefined)
})


test('an incomplete initial host snapshot is preserved instead of defaulting to complete', async (t) => {
  const { localHome, mirrorRoot } = fixture(t)
  const state = createRemoteProjectSkillProvider({
    resolveBinding: async () => binding,
    getHelper: async () => { throw new Error('ssh unavailable') },
    localConfigRoot: path.join(localHome, 'remote-project-config', 'workspace-incomplete'),
    mirrorRoot,
    // No snapshotHostSkills reader at all: suppression cannot be authoritative.
    initialHostSkills: [],
    initialHostComplete: false,
    logger: { warn() {} },
  })
  state.bindControl({ invalidate() {} })
  const result = await state.provider.list({ cwd: mirrorRoot })
  assert.equal(result.complete, false)
})

test('a partially failing host snapshot merges the fresh candidates with the last good view', async (t) => {
  const { localHome, mirrorRoot } = fixture(t)
  const kept = {
    name: 'kept-local',
    description: 'Known good host skill',
    source: 'project-dsh',
    rank: 100,
    path: path.join(mirrorRoot, '.dsh', 'skills', 'kept-local', 'SKILL.md'),
  }
  const fresh = {
    name: 'fresh-local',
    description: 'Discovered despite the incomplete scan',
    source: 'project-agents',
    rank: 200,
    path: path.join(mirrorRoot, '.agents', 'skills', 'fresh-local', 'SKILL.md'),
  }
  let call = 0
  const state = createRemoteProjectSkillProvider({
    resolveBinding: async () => binding,
    getHelper: async () => {
      throw new Error('ssh unavailable')
    },
    localConfigRoot: path.join(localHome, 'remote-project-config', 'workspace-merge'),
    mirrorRoot,
    // list() may read the host snapshot twice per refresh (manifest success
    // path, then the offline fallback); only the later incomplete scan matters.
    snapshotHostSkills: async () => {
      call += 1
      if (call <= 2) return { skills: [kept], complete: true }
      return { skills: [fresh], complete: false }
    },
    logger: { warn() {} },
    now: () => 100000,
  })
  state.bindControl({ invalidate() {} })
  const first = await state.provider.list({ cwd: mirrorRoot })
  assert.ok(first.candidates.some((candidate) => candidate.name === 'kept-local'))
  assert.equal(first.candidates.some((candidate) => candidate.name === 'fresh-local'), false)

  // Second scan is incomplete: the fresh candidate must not erase the last
  // good view, and both must remain classified as local mirror candidates.
  state.markDirty()
  const second = await state.provider.list({ cwd: mirrorRoot })
  assert.equal(second.complete, false)
  const secondNames = second.candidates.map((candidate) => candidate.name).sort()
  assert.deepEqual(secondNames, ['fresh-local', 'kept-local'])
})


test('manifest write failure leaves the previous complete snapshot untouched', async (t) => {
  const fixtureState = fixture(t)
  const target = path.join(fixtureState.localConfigRoot, 'manifest.json')
  mkdirSync(fixtureState.localConfigRoot, { recursive: true, mode: 0o700 })
  chmodSync(fixtureState.localConfigRoot, 0o700)
  writeFileSync(target, '{"old":true}', { mode: 0o600 })
  const fsPromises = await import('node:fs/promises')
  const broken = {
    ...fsPromises,
    async rename() { throw new Error('simulated atomic publish failure') },
  }
  await assert.rejects(writeProjectConfigSnapshot(fixtureState.localConfigRoot, manifest(), broken), /simulated atomic publish failure/)
  assert.equal(readFileSync(target, 'utf8'), '{"old":true}')
  assert.deepEqual(readdirSync(fixtureState.localConfigRoot), ['manifest.json'])
})

test('manifest cache rejects shared-readable directories and files without chmod', async (t) => {
  const directoryState = fixture(t)
  mkdirSync(directoryState.localConfigRoot, { recursive: true, mode: 0o700 })
  chmodSync(directoryState.localConfigRoot, 0o755)
  await assert.rejects(writeProjectConfigSnapshot(directoryState.localConfigRoot, manifest()), /directory must be owner-only/)
  assert.equal((statSync(directoryState.localConfigRoot).mode & 0o777), 0o755)

  const fileState = fixture(t)
  mkdirSync(fileState.localConfigRoot, { recursive: true, mode: 0o700 })
  const target = path.join(fileState.localConfigRoot, 'manifest.json')
  writeFileSync(target, '{"existing":true}', { mode: 0o644 })
  await assert.rejects(writeProjectConfigSnapshot(fileState.localConfigRoot, manifest()), /file must be owner-only/)
  assert.equal(readFileSync(target, 'utf8'), '{"existing":true}')
})


test('project cache identity is stable, isolated by machine, and outside remote-workspaces', () => {
  const home = path.join(tmpdir(), `dsh-${randomUUID()}`)
  const workspaces = path.join(home, 'remote-workspaces')
  mkdirSync(workspaces, { recursive: true })
  const a = projectConfigCachePath(home, 'machine-a', root, workspaces)
  const b = projectConfigCachePath(home, 'machine-b', root, workspaces)
  assert.equal(a, projectConfigCachePath(home, 'machine-a', root, workspaces))
  assert.notEqual(a, b)
  assert.equal(path.dirname(a), path.join(realpathSync(home), 'remote-project-config'))
  const relative = path.relative(workspaces, a)
  assert.ok(relative.startsWith('..') || path.isAbsolute(relative))
})

test('project cache path rejects symlink aliases into remote-workspaces', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), `dsh-${randomUUID()}-`))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const workspaces = path.join(home, 'remote-workspaces')
  mkdirSync(workspaces)
  symlinkSync(workspaces, path.join(home, 'remote-project-config'))
  assert.throws(() => projectConfigCachePath(home, 'machine-a', root, workspaces), /may not contain symlinks/)
})
