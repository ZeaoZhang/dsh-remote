import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executionModeStatus } from '../lib/index.js'

test('tool-mode status is allowlisted, read-only and legacy by default', () => {
  const status = executionModeStatus({ host: 'secret.example', password: 'not returned' })
  assert.deepEqual(status, {
    mode: 'legacy',
    reloadRequired: true,
    scope: 'remote-mirror-agents-only',
    rwTools: 'registered',
    remoteTools: [],
    projectSkills: 'disabled',
    projectConfig: 'profile-scoped-only',
    projectConfigReason: 'DSH 0.2.1-rc.3 ConfigEditor writes/reconciles profile patches; no project/Agent config overlay provider is available.',
    projectPlugins: 'unsupported',
    projectPluginsReason: 'The DSH Loader enables profile-declared plugins only; compatibility exemptions are not project execution approvals.',
    searchRequiresRemoteRg: false,
    confinedBashRequiresLinuxBwrap: false,
    remoteDependencyPreflight: 'disabled',
    remotePrerequisites: null,
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
  assert.equal(status.projectConfig, 'profile-scoped-only')
  assert.equal(status.projectPlugins, 'unsupported')
  assert.equal(status.searchRequiresRemoteRg, true)
  assert.equal(status.confinedBashRequiresLinuxBwrap, true)
  assert.equal(status.remoteDependencyPreflight, 'helper-handshake')
  assert.deepEqual(status.remotePrerequisites, { search: 'ripgrep', confinedBash: 'bubblewrap' })
  assert.equal(status.backgroundJobs, false)
  assert.equal(status.taskRecovery, false)
})
