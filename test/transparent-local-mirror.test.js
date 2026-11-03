// Transparent mode's local-mirror contribution: skills and AGENTS.md that live
// only under `~/.dsh/remote-workspaces/` load alongside the remote's own, and
// the remote always wins a name/path collision.
//
// Two halves, matching the two mechanisms:
//   - instructions: `syncInstructionsToMirror(..., { mergeLocal })` keeps an
//     instruction the remote does not have, supersedes an untracked same-path
//     copy with remote content, and still refuses a tracked local edit.
//   - skills: the remote provider stops tombstoning mirror-local skills in
//     merge mode (the core filesystem provider serves their bodies) and serves
//     their reference files from the mirror, while user-level local skills and
//     everything outside the mirror stay suppressed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createRemoteProjectSkillProvider,
} from '../lib/project-config.js'
import { syncInstructionsToMirror } from '../lib/instructions.js'
import { loadSyncState, saveSyncState } from '../lib/sync.js'

function makeMirror(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-transparent-merge-'))
  const dir = path.join(root, 'mirror')
  mkdirSync(dir, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return dir
}

function remoteFile(rel, text, mtime = 1000) {
  const bytes = Buffer.from(text, 'utf8')
  return { rel, size: bytes.length, mtime, content: bytes }
}

// ── instructions ──────────────────────────────────────────────────────────

test('merge keeps a local-only instruction the remote does not have', (t) => {
  const dir = makeMirror(t)
  writeFileSync(path.join(dir, 'AGENTS.md'), '# local-only rules\n')
  const merged = syncInstructionsToMirror([], dir, { removeMissing: ['AGENTS.md'], mergeLocal: true })
  assert.deepEqual(merged.conflicts, [])
  assert.deepEqual(merged.removed, [])
  assert.deepEqual(merged.keptLocal, ['AGENTS.md'])
  assert.equal(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# local-only rules\n')

  // Without merge the same state is the pre-0.8.55 conflict.
  const remoteOnly = syncInstructionsToMirror([], dir, { removeMissing: ['AGENTS.md'] })
  assert.deepEqual(remoteOnly.conflicts, ['AGENTS.md'])
  assert.equal(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# local-only rules\n')
})

test('merge supersedes an untracked same-path instruction with remote content', (t) => {
  const dir = makeMirror(t)
  writeFileSync(path.join(dir, 'AGENTS.md'), '# local draft\n')
  const merged = syncInstructionsToMirror([remoteFile('AGENTS.md', '# remote rules\n')], dir, { mergeLocal: true })
  assert.deepEqual(merged.conflicts, [])
  assert.deepEqual(merged.written, ['AGENTS.md'])
  assert.deepEqual(merged.superseded, ['AGENTS.md'])
  assert.equal(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# remote rules\n')
})

test('merge still refuses a tracked local edit (remote never silently wins a human change)', (t) => {
  const dir = makeMirror(t)
  syncInstructionsToMirror([remoteFile('AGENTS.md', '# v1\n')], dir)
  writeFileSync(path.join(dir, 'AGENTS.md'), '# edited locally, much longer\n')
  const merged = syncInstructionsToMirror([remoteFile('AGENTS.md', '# v2\n', 2000)], dir, { mergeLocal: true })
  assert.deepEqual(merged.conflicts, ['AGENTS.md'])
  assert.deepEqual(merged.written, [])
  assert.equal(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# edited locally, much longer\n')
})

test('merge applies an unmodified rw_sync-tracked copy instead of conflicting', (t) => {
  const dir = makeMirror(t)
  const target = path.join(dir, 'AGENTS.md')
  writeFileSync(target, '# v1\n')
  const info = statSync(target)
  // rw_sync records only size/mtime for tracked files (never sha256).
  saveSyncState(dir, { 'AGENTS.md': { size: info.size, mtime: Math.floor(info.mtimeMs / 1000) } })
  assert.deepEqual(Object.keys(loadSyncState(dir)), ['AGENTS.md'])

  const merged = syncInstructionsToMirror([remoteFile('AGENTS.md', '# v2 remote\n', 2000)], dir, { mergeLocal: true })
  assert.deepEqual(merged.conflicts, [])
  assert.deepEqual(merged.written, ['AGENTS.md'])
  assert.equal(readFileSync(target, 'utf8'), '# v2 remote\n')
})

// ── skills ────────────────────────────────────────────────────────────────

const remoteRoot = '/srv/projects/app'
const remoteSkillPath = `${remoteRoot}/.dsh/skills/review/SKILL.md`

function skillText(name, body = 'Do the thing.') {
  return `---\nname: ${name}\ndescription: ${name} skill\nuser-invocable: true\n---\n${body}\n`
}

function remoteEntry(name) {
  const text = skillText(name)
  return {
    path: `${remoteRoot}/.dsh/skills/${name}/SKILL.md`,
    directory: `${remoteRoot}/.dsh/skills/${name}`,
    relative: `.dsh/skills/${name}/SKILL.md`,
    source: 'project-dsh',
    rank: 100,
    size: Buffer.byteLength(text),
    mtimeMs: 123,
    version: createHash('sha256').update(text).digest('hex'),
    content: text,
  }
}

function manifest(entries) {
  const snapshotVersion = createHash('sha256')
    .update(JSON.stringify(entries.map(({ path: filePath, source, size, mtimeMs, version }) => ({ path: filePath, source, size, mtimeMs, version }))))
    .digest('hex')
  return { root: remoteRoot, snapshotVersion, complete: true, entries, diagnostics: [] }
}

function skillsFixture(t, { mergeLocalMirror, hostSkills = [] }) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-transparent-skills-'))
  const mirrorRoot = path.join(home, 'remote-workspaces', 'host')
  mkdirSync(mirrorRoot, { recursive: true })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const requests = []
  const remoteManifest = manifest([remoteEntry('review')])
  const helper = {
    rpc: {
      async request(op, payload) {
        requests.push({ op, payload })
        if (op === 'project_skills_manifest') return remoteManifest
        if (op === 'project_skill_read') return { path: payload.path, directory: path.posix.dirname(payload.path), text: 'reference body\n' }
        throw new Error(`unexpected helper operation: ${op}`)
      },
    },
  }
  const state = createRemoteProjectSkillProvider({
    resolveBinding: async () => ({ bound: true, ws: remoteRoot, machine: { id: 'machine-a' }, pool: {} }),
    getHelper: async () => helper,
    localConfigRoot: path.join(home, 'remote-project-config', 'workspace-a'),
    mirrorRoot,
    snapshotHostSkills: async () => ({ complete: true, skills: hostSkills.slice() }),
    initialHostComplete: false,
    mergeLocalMirror,
    logger: { warn() {} },
    now: () => 100000,
  })
  state.bindControl({ invalidate() {} })
  return { helper, hostSkills, mirrorRoot, requests, state }
}

function mirrorSkill(mirrorRoot, name) {
  const directory = path.join(mirrorRoot, '.dsh', 'skills', name)
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, 'SKILL.md')
  writeFileSync(file, skillText(name))
  writeFileSync(path.join(directory, 'references.md'), '# local reference\n')
  return { name, source: 'project-dsh', provider: 'filesystem', rank: 100, path: file }
}

test('merge mode keeps mirror-local skills visible and still tombstones user-level ones', async (t) => {
  const userSkill = { name: 'user-extra', source: 'user-dsh', provider: 'filesystem', rank: 300, path: '/home/me/.dsh/skills/user-extra/SKILL.md' }
  const merged = skillsFixture(t, { mergeLocalMirror: true })
  const mirror = mirrorSkill(merged.mirrorRoot, 'mirror-helper')
  merged.hostSkills.push(mirror, userSkill)
  merged.state.markDirty()
  const byName = new Map((await merged.state.provider.list()).candidates.map((candidate) => [candidate.name, candidate]))
  assert.ok(byName.has('review'))
  assert.equal(byName.has('mirror-helper'), false, 'mirror skill must not be tombstoned; the filesystem provider serves it')
  assert.equal(byName.get('user-extra')?.locator?.suppressed, true, 'user-level local skills stay suppressed')

  const strict = skillsFixture(t, { mergeLocalMirror: false })
  const strictMirror = mirrorSkill(strict.mirrorRoot, 'mirror-helper')
  strict.hostSkills.push(strictMirror, userSkill)
  strict.state.markDirty()
  const strictByName = new Map((await strict.state.provider.list()).candidates.map((candidate) => [candidate.name, candidate]))
  assert.equal(strictByName.get('mirror-helper')?.locator?.suppressed, true, 'remote-only mode keeps the 0.8.54 tombstone')
})

test('merge mode serves mirror-only skill reference files from the local mirror', async (t) => {
  const fixture = skillsFixture(t, { mergeLocalMirror: true })
  const local = mirrorSkill(fixture.mirrorRoot, 'mirror-helper')
  fixture.hostSkills.push(local)
  fixture.state.markDirty()
  await fixture.state.provider.list()
  const before = fixture.requests.length

  const localReference = path.join(path.dirname(local.path), 'references.md')
  const served = await fixture.state.readResource(localReference)
  assert.equal(served.path, localReference)
  assert.match(served.text, /local reference/)
  assert.equal(fixture.requests.length, before, 'a mirror-only resource must not touch the remote')

  // A remote-form path under the same skill maps back to the mirror.
  const viaRemote = await fixture.state.readResource(`${remoteRoot}/.dsh/skills/mirror-helper/references.md`)
  assert.match(viaRemote.text, /local reference/)
  assert.equal(fixture.requests.length, before)

  // Paths outside every mirror-only skill directory stay remote-only.
  assert.equal(await fixture.state.readResource(path.join(fixture.mirrorRoot, 'AGENTS.md')), undefined)
  assert.equal(await fixture.state.readResource(path.join(fixture.mirrorRoot, '.dsh', 'skills', 'review', 'references.md')), undefined)

  // Remote resources still go through the helper RPC.
  const remoteResource = await fixture.state.readResource(`${remoteRoot}/.dsh/skills/review/guide.md`)
  assert.equal(remoteResource.path, `${remoteRoot}/.dsh/skills/review/guide.md`)
  assert.equal(fixture.requests.at(-1).op, 'project_skill_read')
  assert.equal(fixture.requests.at(-1).payload.resource, true)
})

test('remote-only mode never serves local mirror resources', async (t) => {
  const fixture = skillsFixture(t, { mergeLocalMirror: false })
  const local = mirrorSkill(fixture.mirrorRoot, 'mirror-helper')
  fixture.hostSkills.push(local)
  fixture.state.markDirty()
  await fixture.state.provider.list()
  const before = fixture.requests.length
  const reference = path.join(path.dirname(local.path), 'references.md')
  assert.equal(await fixture.state.readResource(reference), undefined)
  assert.equal(fixture.requests.length, before)
})
