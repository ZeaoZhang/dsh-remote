import { createHash } from 'node:crypto'
import path from 'node:path'

const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])

function sniffImageMediaType(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'image/gif'
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

async function assertImageRoute(exec, llm, requestedPath) {
  const routed = exec?.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec?.agent?.options?.provider
  const model = routed?.model ?? exec?.agent?.options?.model
  if (provider === undefined || model === undefined || !llm) {
    throw new Error(`cannot read "${requestedPath}" as an image: the current model route could not be resolved`)
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (!active?.inputModalities?.includes('image')) {
    throw new Error(`cannot read "${requestedPath}" as an image: model "${model}" does not declare image input; switch to an image-capable model to read images`)
  }
}

function imageMetadata(ref) {
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
  }
}

function normalizeAttachmentError(error, displayPath, extension, declared, mediaType) {
  if (error?.code === 'IMAGE_DIMENSION_TOO_LARGE') {
    throw new Error(`cannot read "${displayPath}": at least one image side exceeds the image dimension limit; downscale the image and read the smaller copy`, { cause: error })
  }
  if (error?.code === 'IMAGE_TOO_MANY_PIXELS') {
    throw new Error(`cannot read "${displayPath}": the image exceeds the decoded-size limit; downscale the image and read the smaller copy`, { cause: error })
  }
  if (error?.code === 'IMAGE_TOO_LARGE') {
    throw new Error(`cannot read "${displayPath}": the image cannot be stored within the deployment's byte limits; downscale the image and read the smaller copy`, { cause: error })
  }
  if (error?.code === 'ATTACHMENT_WRITE_FAILED' && /16-bit PNG/iu.test(String(error.message || ''))) {
    throw new Error(`cannot read "${displayPath}": the 16-bit PNG could not be converted to the normalized 8-bit sRGB form; convert it to an 8-bit PNG/JPEG/WebP and retry`, { cause: error })
  }
  if (error?.code === 'INVALID_IMAGE' && declared === undefined) {
    throw new Error(`cannot read "${displayPath}": the bytes do not decode as a supported PNG/JPEG/WebP/GIF image; the file may be truncated or corrupt`, { cause: error })
  }
  if (error?.code !== 'IMAGE_TYPE_MISMATCH') throw error
  if (declared === undefined) {
    throw new Error(`cannot read "${displayPath}": the file signature claims ${mediaType}, but the bytes decode as a different image format; the file may be corrupt`, { cause: error })
  }
  throw new Error(`cannot read "${displayPath}": the ${extension} extension declares ${mediaType}, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`, { cause: error })
}

export async function readRemoteImage({ args, exec, remotePath, helper, attachments, llm }) {
  const requestedPath = String(args?.file_path || '')
  if (!requestedPath.trim()) throw new Error('file_path must be a non-empty string')
  const extension = path.posix.extname(requestedPath).toLowerCase()
  const declared = IMAGE_TYPES.get(extension)
  if (declared === undefined && extension !== '') {
    throw new Error(`cannot read "${requestedPath}": the ${extension} extension does not declare a supported image format; read_image accepts PNG/JPEG/WebP/GIF files, including extension-less files in those formats`)
  }
  if (!attachments) throw new Error(`cannot read "${requestedPath}" as an image: no attachment service is mounted`)
  if (typeof attachments.saveImage !== 'function' || !Array.isArray(attachments.imageLimits?.mediaTypes)) {
    throw new Error('transparent remote read_image requires the DSH attachment service')
  }
  if (declared !== undefined && !attachments.imageLimits.mediaTypes.includes(declared)) {
    throw new Error(`cannot read "${requestedPath}": ${declared} images are not accepted by this deployment`)
  }
  await assertImageRoute(exec, llm, requestedPath)

  const maxBytes = Math.min(
    Number(attachments.imageLimits.maxImageBytes),
    Number(attachments.imageLimits.maxMessageImageBytes),
  )
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('transparent remote read_image cannot resolve the deployment image byte limits')
  }

  const rpc = helper?.rpc
  if (!rpc || typeof rpc.request !== 'function') throw new Error('transparent remote helper is unavailable')
  let transferId
  try {
    const transfer = await rpc.request('image_begin', { path: remotePath, maxBytes }, { signal: exec?.signal })
    transferId = transfer?.transferId
    if (typeof transferId !== 'string' || !transferId) throw new Error('remote helper returned an invalid image transfer id')
    if (typeof transfer.path !== 'string' || !path.posix.isAbsolute(transfer.path)) throw new Error('remote helper returned an invalid image path')
    if (!Number.isSafeInteger(transfer.bytes) || transfer.bytes < 0 || transfer.bytes > maxBytes) {
      throw new Error('remote helper returned an invalid image byte count')
    }
    if (typeof transfer.version !== 'string' || !/^[a-f0-9]{64}$/i.test(transfer.version)) {
      throw new Error('remote helper returned an invalid image version')
    }
    if (!Number.isSafeInteger(transfer.chunkSize) || transfer.chunkSize < 1 || transfer.chunkSize > 1024 * 1024) {
      throw new Error('remote helper returned an invalid image chunk size')
    }

    const chunks = []
    for (let offset = 0; offset < transfer.bytes; offset += transfer.chunkSize) {
      const chunk = await rpc.request('image_chunk', {
        transferId,
        offset,
        length: Math.min(transfer.chunkSize, transfer.bytes - offset),
      }, { signal: exec?.signal })
      if (chunk?.transferId !== transferId || chunk.offset !== offset || chunk.version !== transfer.version || typeof chunk.data !== 'string') {
        throw new Error('remote helper returned an invalid image chunk')
      }
      const data = Buffer.from(chunk.data, 'base64')
      if (data.length !== Math.min(transfer.chunkSize, transfer.bytes - offset)) {
        throw new Error('remote helper returned a truncated image chunk')
      }
      chunks.push(data)
    }
    const data = Buffer.concat(chunks, transfer.bytes)
    if (createHash('sha256').update(data).digest('hex') !== transfer.version) {
      throw new Error('remote image changed or was corrupted during transfer')
    }

    const mediaType = declared ?? sniffImageMediaType(data)
    if (mediaType === undefined) {
      throw new Error(`cannot read "${transfer.path}": the file content is not a supported image format; read_image accepts PNG/JPEG/WebP/GIF`)
    }
    if (declared === undefined && !attachments.imageLimits.mediaTypes.includes(mediaType)) {
      throw new Error(`cannot read "${transfer.path}": ${mediaType} images are not accepted by this deployment`)
    }

    let ref
    try {
      ref = await attachments.saveImage({ data, mediaType, name: path.posix.basename(transfer.path) })
    } catch (error) {
      normalizeAttachmentError(error, transfer.path, extension, declared, mediaType)
    }
    return { path: transfer.path, version: transfer.version, image: imageMetadata(ref) }
  } finally {
    if (transferId) await rpc.request('image_release', { transferId }, { timeoutMs: 5000 }).catch(() => {})
  }
}
