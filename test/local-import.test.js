import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createLocalImporter, defaultImportRoots, inspectLocalFile } from '../lib/local-import.js'

const WORKSPACE = '/srv/project'

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function fakeSftp() {
  const files = new Map()
  const calls = { fastPut: [], mkdir: [], renameOverwrite: [], stat: [], unlink: [] }
  return {
    calls,
    files,
    async stat(p) {
      calls.stat.push(p)
      const entry = files.get(p)
      if (!entry) throw Object.assign(new Error('no such file'), { code: 2 })
      return { size: entry.size }
    },
    async mkdir(p) {
      calls.mkdir.push(p)
      if (files.has(p)) throw new Error('failure')
      files.set(p, { dir: true, size: 0 })
    },
    async fastPut(localFile, remotePath) {
      calls.fastPut.push([localFile, remotePath])
      const data = await readFile(localFile)
      files.set(remotePath, { size: data.length })
    },
    async renameOverwrite(from, to) {
      calls.renameOverwrite.push([from, to])
      const entry = files.get(from)
      if (!entry) throw new Error('no such file')
      files.delete(from)
      files.set(to, entry)
    },
    async unlink(p) {
      calls.unlink.push(p)
      files.delete(p)
    },
  }
}

function workspace(t) {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-local-import-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const root = path.join(temp, 'attachments')
  const mirrorDir = path.join(temp, 'mirror')
  mkdirSync(root, { recursive: true })
  mkdirSync(mirrorDir, { recursive: true })
  const sftp = fakeSftp()
  const binding = { ws: WORKSPACE, mirrorDir, pool: { async sftp() { return sftp } } }
  return { binding, mirrorDir, root, sftp, temp }
}

test('inspectLocalFile accepts a regular file under a root and reports its real path', async (t) => {
  const { root } = workspace(t)
  const file = path.join(root, 'notes.md')
  writeFileSync(file, 'hello')

  const inspected = await inspectLocalFile(file, { roots: [realpathSync(root)], maxBytes: 1024 })

  assert.equal(inspected.ok, true)
  assert.equal(inspected.size, 5)
  assert.equal(path.basename(inspected.realPath), 'notes.md')
})

test('inspectLocalFile explains every rejection', async (t) => {
  const { root, temp } = workspace(t)
  const outside = path.join(temp, 'outside', 'secret.txt')
  mkdirSync(path.dirname(outside), { recursive: true })
  writeFileSync(outside, 'secret')
  const big = path.join(root, 'big.bin')
  writeFileSync(big, Buffer.alloc(64))
  const dir = path.join(root, 'folder')
  mkdirSync(dir)
  const escaped = path.join(root, 'link.txt')
  symlinkSync(outside, escaped)

  const roots = [realpathSync(root)]
  assert.match((await inspectLocalFile(path.join(root, 'missing.txt'), { roots, maxBytes: 1024 })).reason, /does not exist on this machine/)
  assert.match((await inspectLocalFile(dir, { roots, maxBytes: 1024 })).reason, /not a regular file/)
  assert.match((await inspectLocalFile(big, { roots, maxBytes: 16 })).reason, /above the local import limit/)
  assert.match((await inspectLocalFile(outside, { roots, maxBytes: 1024 })).reason, /outside the local import roots/)
  // A symlink must not smuggle a file out of the allowed roots.
  assert.match((await inspectLocalFile(escaped, { roots, maxBytes: 1024 })).reason, /outside the local import roots/)
})

test('importFile uploads atomically into a content-addressed remote directory and records a ledger', async (t) => {
  const { binding, mirrorDir, root, sftp } = workspace(t)
  const file = path.join(root, 'spec.md')
  writeFileSync(file, '# spec')
  const importer = createLocalImporter({ config: { localImportRoots: [root] } })

  const result = await importer.importFile({ localPath: file, binding })

  const digest = sha256('# spec')
  assert.equal(result.remotePath, `${WORKSPACE}/.dsh-remote/imports/${digest}/spec.md`)
  assert.equal(result.sha256, digest)
  assert.equal(result.reused, false)
  assert.equal(sftp.calls.fastPut.length, 1)
  assert.match(sftp.calls.fastPut[0][1], new RegExp(`^${result.remotePath}\\.incoming-[0-9a-f-]+$`))
  assert.equal(sftp.calls.mkdir.includes(`${WORKSPACE}/.dsh-remote`), true)
  assert.equal(sftp.calls.mkdir.includes(`${WORKSPACE}/.dsh-remote/imports`), true)
  assert.equal(sftp.calls.mkdir.includes(`${WORKSPACE}/.dsh-remote/imports/${digest}`), true)
  assert.deepEqual(sftp.calls.renameOverwrite.map(([, to]) => to), [result.remotePath])
  assert.equal(sftp.files.get(result.remotePath).size, 6)

  const ledger = JSON.parse(readFileSync(path.join(mirrorDir, '.dsh-remote-imports.json'), 'utf8'))
  const entry = ledger.entries[realpathSync(file)]
  assert.equal(entry.sha256, digest)
  assert.equal(entry.remotePath, result.remotePath)
})

test('a second import of an unchanged file reuses the ledger instead of uploading', async (t) => {
  const { binding, root, sftp } = workspace(t)
  const file = path.join(root, 'spec.md')
  writeFileSync(file, '# spec')
  const importer = createLocalImporter({ config: { localImportRoots: [root] } })

  const first = await importer.importFile({ localPath: file, binding })
  const second = await importer.importFile({ localPath: file, binding })

  assert.equal(second.remotePath, first.remotePath)
  assert.equal(second.reused, true)
  assert.equal(sftp.calls.fastPut.length, 1)
})

test('changed content lands under a new digest', async (t) => {
  const { binding, root, sftp } = workspace(t)
  const file = path.join(root, 'spec.md')
  writeFileSync(file, 'one')
  const importer = createLocalImporter({ config: { localImportRoots: [root] } })
  const first = await importer.importFile({ localPath: file, binding })

  writeFileSync(file, 'two-two')
  const second = await importer.importFile({ localPath: file, binding })

  assert.notEqual(second.remotePath, first.remotePath)
  assert.match(second.remotePath, new RegExp(sha256('two-two')))
  assert.equal(sftp.calls.fastPut.length, 2)
})

test('an already staged remote copy with the right size is not uploaded again', async (t) => {
  const { binding, root, sftp } = workspace(t)
  const file = path.join(root, 'spec.md')
  writeFileSync(file, '# spec')
  const digest = sha256('# spec')
  const remotePath = `${WORKSPACE}/.dsh-remote/imports/${digest}/spec.md`
  sftp.files.set(`${WORKSPACE}/.dsh-remote`, { dir: true, size: 0 })
  sftp.files.set(`${WORKSPACE}/.dsh-remote/imports`, { dir: true, size: 0 })
  sftp.files.set(`${WORKSPACE}/.dsh-remote/imports/${digest}`, { dir: true, size: 0 })
  sftp.files.set(remotePath, { size: 6 })
  const importer = createLocalImporter({ config: { localImportRoots: [root] } })

  const result = await importer.importFile({ localPath: file, binding })

  assert.equal(result.remotePath, remotePath)
  assert.equal(sftp.calls.fastPut.length, 0)
  assert.equal(sftp.calls.renameOverwrite.length, 0)
})

test('concurrent imports of the same file upload once', async (t) => {
  const { binding, root, sftp } = workspace(t)
  const file = path.join(root, 'spec.md')
  writeFileSync(file, '# spec')
  const importer = createLocalImporter({ config: { localImportRoots: [root] } })

  const [a, b] = await Promise.all([
    importer.importFile({ localPath: file, binding }),
    importer.importFile({ localPath: file, binding }),
  ])

  assert.equal(a.remotePath, b.remotePath)
  assert.equal(sftp.calls.fastPut.length, 1)
})

test('files outside the configured roots are rejected before any transfer', async (t) => {
  const { binding, root, sftp, temp } = workspace(t)
  const outside = path.join(temp, 'elsewhere.txt')
  writeFileSync(outside, 'nope')
  const importer = createLocalImporter({ config: { localImportRoots: [root] } })

  await assert.rejects(importer.importFile({ localPath: outside, binding }), (error) => {
    assert.equal(error.code, 'LOCAL_IMPORT_REJECTED')
    assert.match(error.message, /outside the local import roots/)
    return true
  })
  assert.equal(sftp.calls.fastPut.length, 0)
})

test('local imports can be disabled', async (t) => {
  const { binding, root } = workspace(t)
  const file = path.join(root, 'spec.md')
  writeFileSync(file, 'x')
  const importer = createLocalImporter({ config: { localImport: false, localImportRoots: [root] } })

  assert.equal(await importer.isImportable(file), false)
  await assert.rejects(importer.importFile({ localPath: file, binding }), /disabled in this deployment/)
})

test('default roots live under the harness home', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/dsh-home-test'
  try {
    assert.deepEqual(defaultImportRoots(), [
      path.join('/tmp/dsh-home-test', 'attachments'),
      path.join('/tmp/dsh-home-test', 'browser-control'),
    ])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a ledger entry whose staged copy disappeared is re-imported', async (t) => {
  const { binding, root, sftp } = workspace(t)
  const file = path.join(root, 'spec.md')
  writeFileSync(file, '# spec')
  const importer = createLocalImporter({ config: { localImportRoots: [root] } })

  const first = await importer.importFile({ localPath: file, binding })
  sftp.files.delete(first.remotePath) // a user cleaned <ws>/.dsh-remote
  const second = await importer.importFile({ localPath: file, binding })

  assert.equal(second.remotePath, first.remotePath)
  assert.equal(second.reused, false)
  assert.equal(sftp.calls.fastPut.length, 2)
})
