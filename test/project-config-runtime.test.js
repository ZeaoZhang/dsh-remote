import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'

const invocation = { modelInvocable: true, userInvocable: true }

function candidate(name, path, provider, invocationValue = invocation) {
  return {
    name,
    description: `${provider} ${name}`,
    source: 'project-dsh',
    provider,
    rank: 100,
    invocation: invocationValue,
    path,
    locator: { path },
    resourceBase: { kind: 'directory', path: path.slice(0, path.lastIndexOf('/')) },
  }
}

test('real DSH SkillRegistry resolves remote same-name entries and never falls back through tombstones', async (t) => {
  const ctx = new Context()
  const registry = new SkillRegistry(ctx)
  const scopeKey = Symbol('remote-agent')
  const agentScope = createScope(ctx, scopeKey)
  let localLoads = 0
  let remoteLoads = 0

  const disposeLocal = ctx.skills.registerProvider(() => ({
    name: 'filesystem',
    list: async () => ({
      complete: true,
      candidates: [
        candidate('review', '/local/mirror/.dsh/skills/review/SKILL.md', 'filesystem'),
        candidate('stale-local', '/local/mirror/.dsh/skills/stale-local/SKILL.md', 'filesystem'),
      ],
    }),
    get: async (item) => {
      localLoads += 1
      return { ...item, content: 'local mirror body' }
    },
  }))
  const disposeRemote = agentScope.ctx.skills.registerProvider(() => ({
    name: 'dsh-remote-project',
    list: async () => ({
      complete: true,
      candidates: [
        candidate('review', '/srv/project/.dsh/skills/review/SKILL.md', 'dsh-remote-project'),
        candidate('stale-local', '/local/mirror/.dsh/skills/stale-local/SKILL.md', 'dsh-remote-project', {
          modelInvocable: false,
          userInvocable: false,
        }),
      ],
    }),
    get: async (item) => {
      if (item.invocation.modelInvocable === false) return undefined
      remoteLoads += 1
      return { ...item, content: 'remote project body' }
    },
  }))

  t.after(async () => {
    disposeRemote()
    disposeLocal()
    await agentScope.dispose()
  })

  const snapshot = await registry.snapshot({ cwd: '/local/mirror', scope: scopeKey })
  assert.ok(snapshot.skills.some((item) => item.name === 'review'))
  const loadedReview = await registry.get('review', { cwd: '/local/mirror', scope: scopeKey })
  assert.equal(loadedReview.path, '/srv/project/.dsh/skills/review/SKILL.md')
  assert.equal(loadedReview.content, 'remote project body')
  assert.equal(await registry.get('stale-local', { cwd: '/local/mirror', scope: scopeKey }), undefined)
  assert.equal(remoteLoads, 1)
  assert.equal(localLoads, 0)
})
