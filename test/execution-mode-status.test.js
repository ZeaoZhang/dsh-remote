import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executionModeStatus, normalizeTransparentLocalMirror, skillResourceResult } from '../lib/index.js'

test('tool-mode status is allowlisted, read-only and legacy by default', () => {
  const status = executionModeStatus({ host: 'secret.example', password: 'not returned' })
  assert.deepEqual(status, {
    mode: 'legacy',
    reloadRequired: true,
    scope: 'remote-mirror-agents-only',
    rwTools: 'registered',
    remoteTools: [],
    projectSkills: 'disabled',
    transparentLocalMirror: 'n/a',
    projectConfig: 'profile-scoped-only',
    projectConfigReason: 'DSH 0.2.1-rc.3 ConfigEditor writes/reconciles profile patches; no project/Agent config overlay provider is available.',
    projectPlugins: 'unsupported',
    projectPluginsReason: 'The DSH Loader enables profile-declared plugins only; compatibility exemptions are not project execution approvals.',
    searchRequiresRemoteRg: false,
    confinedBashRequiresLinuxBwrap: false,
    remoteDependencyPreflight: 'disabled',
    remotePrerequisites: null,
    remoteMcp: null,
    backgroundJobs: false,
    pty: false,
    taskRecovery: false,
  })
  assert.equal(JSON.stringify(status).includes('secret.example'), false)
  assert.equal(JSON.stringify(status).includes('not returned'), false)
})

test('transparent mode status lists only enabled routes and known limitations', () => {
  const status = executionModeStatus({ executionMode: 'transparent' })
  assert.equal(status.mode, 'transparent')
  assert.deepEqual(status.remoteTools, ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash'])
  assert.equal(status.projectSkills, 'agent-scoped')
  assert.equal(status.transparentLocalMirror, 'merge')
  assert.equal(executionModeStatus({ executionMode: 'transparent', transparentLocalMirror: 'remote-only' }).transparentLocalMirror, 'remote-only')
  assert.equal(status.projectConfig, 'profile-scoped-only')
  assert.equal(status.projectPlugins, 'unsupported')
  assert.equal(status.searchRequiresRemoteRg, true)
  assert.equal(status.confinedBashRequiresLinuxBwrap, false)
  assert.equal(status.remoteDependencyPreflight, 'helper-handshake')
  assert.deepEqual(status.remotePrerequisites, { search: 'ripgrep' })
  assert.deepEqual(status.remoteMcp, { transport: 'stdio', dependency: '@deepseek-ai/dsh-mcp-client' })
  assert.equal(status.backgroundJobs, false)
  assert.equal(status.taskRecovery, false)
})

test('transparent local-mirror mode normalizes to merge unless explicitly remote-only', () => {
  assert.equal(normalizeTransparentLocalMirror(undefined), 'merge')
  assert.equal(normalizeTransparentLocalMirror('merge'), 'merge')
  assert.equal(normalizeTransparentLocalMirror('anything-else'), 'merge')
  for (const value of ['remote-only', 'remote', 'off', 'false', '0', ' OFF ']) {
    assert.equal(normalizeTransparentLocalMirror(value), 'remote-only', value)
  }
})

test('skill resources are sliced into the standard read shape', () => {
  const resource = { path: '/root/.dsh/skills/pdf/SKILL.md', text: 'one\ntwo\nthree\n' }
  assert.deepEqual(skillResourceResult(resource, {}), {
    path: '/root/.dsh/skills/pdf/SKILL.md',
    offset: 1,
    lines: ['one', 'two', 'three'],
    totalLines: 3,
  })
  assert.deepEqual(skillResourceResult(resource, { offset: 2, limit: 1 }).lines, ['two'])
  assert.throws(() => skillResourceResult(resource, { offset: 9 }), /offset 9 is out of range/)
  assert.deepEqual(skillResourceResult({ path: '/x/empty.md', text: '' }, {}), { path: '/x/empty.md', offset: 1, lines: [], totalLines: 0 })
})
