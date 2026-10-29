import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { readRemoteImage } from '../lib/remote-image.js'

const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from('small-image-payload'),
])
const VERSION = createHash('sha256').update(PNG).digest('hex')

function fixture(options = {}) {
  const calls = []
  const helper = { rpc: { async request(op, payload, requestOptions) {
    calls.push({ op, payload, requestOptions })
    if (options.request) return options.request(op, payload)
    if (op === 'image_begin') return {
      transferId: 'transfer-1', path: '/remote/project/diagram', version: VERSION,
      bytes: PNG.length, chunkSize: 7,
    }
    if (op === 'image_chunk') return {
      transferId: payload.transferId,
      offset: payload.offset,
      version: VERSION,
      data: PNG.subarray(payload.offset, payload.offset + payload.length).toString('base64'),
    }
    if (op === 'image_release') return { released: true }
    throw new Error(`unexpected op ${op}`)
  } } }
  const attachments = {
    imageLimits: { maxImageBytes: 1024, maxMessageImageBytes: 512, mediaTypes: ['image/png'] },
    async saveImage(input) {
      if (options.saveImage) return options.saveImage(input)
      return { attachmentId: 'attachment-1', mediaType: input.mediaType, bytes: input.data.length, width: 2, height: 3, name: input.name }
    },
  }
  const exec = {
    signal: new AbortController().signal,
    agent: {
      options: { provider: 'provider', model: 'model' },
      session: { requestHeader: () => ({ config: { provider: 'provider', model: 'model' } }) },
    },
  }
  const llm = {
    async resolveModelInfo(provider, model) {
      if (options.modalities) return { inputModalities: options.modalities }
      assert.equal(provider, 'provider')
      assert.equal(model, 'model')
      return { inputModalities: ['text', 'image'] }
    },
  }
  return { attachments, calls, exec, helper, llm }
}

test('reads remote image in bounded verified chunks and stores a DSH attachment', async () => {
  const state = fixture()
  const result = await readRemoteImage({
    args: { file_path: 'diagram' },
    exec: state.exec,
    remotePath: '/remote/project/diagram',
    helper: state.helper,
    attachments: state.attachments,
    llm: state.llm,
  })

  assert.equal(result.path, '/remote/project/diagram')
  assert.equal(result.version, VERSION)
  assert.deepEqual(result.image, {
    attachmentId: 'attachment-1',
    mediaType: 'image/png',
    bytes: PNG.length,
    width: 2,
    height: 3,
    name: 'diagram',
  })
  assert.equal(state.calls[0].op, 'image_begin')
  assert.equal(state.calls[0].payload.maxBytes, 512)
  assert.equal(state.calls.at(-1).op, 'image_release')
  assert.equal(state.calls.filter(({ op }) => op === 'image_chunk').length, Math.ceil(PNG.length / 7))
})

test('rejects unsupported extensions and non-image model routes before requesting image bytes', async () => {
  const state = fixture()
  await assert.rejects(readRemoteImage({
    args: { file_path: 'diagram.bmp' }, exec: state.exec, remotePath: '/remote/project/diagram.bmp',
    helper: state.helper, attachments: state.attachments, llm: state.llm,
  }), /extension does not declare a supported image format/)
  assert.equal(state.calls.length, 0)

  const noImageRoute = fixture({ modalities: ['text'] })
  await assert.rejects(readRemoteImage({
    args: { file_path: 'diagram' }, exec: noImageRoute.exec, remotePath: '/remote/project/diagram',
    helper: noImageRoute.helper, attachments: noImageRoute.attachments, llm: noImageRoute.llm,
  }), /does not declare image input/)
  assert.equal(noImageRoute.calls.length, 0)
})

test('rejects corrupt chunks and releases their remote transfer', async () => {
  const state = fixture({ request: async (op, payload) => {
    if (op === 'image_begin') return {
      transferId: 'transfer-1', path: '/remote/project/diagram', version: VERSION,
      bytes: PNG.length, chunkSize: 7,
    }
    if (op === 'image_chunk') return {
      transferId: payload.transferId, offset: payload.offset, version: VERSION, data: Buffer.from('bad').toString('base64'),
    }
    if (op === 'image_release') return { released: true }
    throw new Error(`unexpected op ${op}`)
  } })
  await assert.rejects(readRemoteImage({
    args: { file_path: 'diagram' }, exec: state.exec, remotePath: '/remote/project/diagram',
    helper: state.helper, attachments: state.attachments, llm: state.llm,
  }), /truncated image chunk/)
  assert.equal(state.calls.at(-1).op, 'image_release')
})
