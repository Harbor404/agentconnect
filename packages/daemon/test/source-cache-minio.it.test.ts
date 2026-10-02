import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SourceCacheConfigSchema } from '../src/source-cache/config.js'
import { createSourceCacheSigner } from '../src/source-cache/signer.js'

const ENABLED = process.env.AC_SOURCE_CACHE_MINIO === '1'
const ENDPOINT = process.env.AC_SOURCE_CACHE_MINIO_ENDPOINT ?? 'http://127.0.0.1:19000'
const ACCESS_KEY_ID = process.env.AC_SOURCE_CACHE_MINIO_ACCESS_KEY ?? 'minioadmin'
const SECRET_ACCESS_KEY = process.env.AC_SOURCE_CACHE_MINIO_SECRET_KEY ?? 'minioadmin'
const BUCKET = process.env.AC_SOURCE_CACHE_MINIO_BUCKET ?? 'agentconnect-source-cache'

describe.skipIf(!ENABLED)('source cache presigner against MinIO', () => {
  it('accepts the signed PUT headers and serves the signed GET', async () => {
    const signer = createSourceCacheSigner(
      SourceCacheConfigSchema.parse({
        endpoint: ENDPOINT,
        region: 'us-east-1',
        bucket: BUCKET,
        prefix: 'it',
        forcePathStyle: true,
        credentials: {
          source: 'secret',
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET_ACCESS_KEY
        },
        limits: {}
      })
    )!
    const key = `src/contract/${randomUUID()}.bundle`
    const body = Buffer.from(`source-cache-presign-${randomUUID()}`)
    const checksumSha256 = createHash('sha256').update(body).digest('base64')

    const putUrl = await signer.presignPut(key, {
      contentLength: body.byteLength,
      checksumSha256
    })
    const tampered = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        'content-length': String(body.byteLength),
        'x-amz-checksum-sha256': checksumSha256,
        'x-amz-tagging': 'ac-cache=live'
      },
      body
    })
    expect(tampered.status, await tampered.text()).toBe(403)

    const put = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        'content-length': String(body.byteLength),
        'x-amz-checksum-sha256': checksumSha256,
        'x-amz-tagging': 'ac-cache=pending'
      },
      body
    })
    expect(put.status, await put.text()).toBe(200)

    const get = await fetch(await signer.presignGet(key))
    expect(get.status).toBe(200)
    expect(Buffer.from(await get.arrayBuffer())).toEqual(body)
  })

  it('rejects the same signed URL when the body changes the signed Content-Length', async () => {
    const signer = createSourceCacheSigner(
      SourceCacheConfigSchema.parse({
        endpoint: ENDPOINT,
        region: 'us-east-1',
        bucket: BUCKET,
        prefix: 'it',
        forcePathStyle: true,
        credentials: {
          source: 'secret',
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET_ACCESS_KEY
        },
        limits: {}
      })
    )!
    const key = `src/contract/${randomUUID()}.bundle`
    const body = Buffer.from(`source-cache-presign-length-${randomUUID()}`)
    const checksumSha256 = createHash('sha256').update(body).digest('base64')
    const putUrl = await signer.presignPut(key, {
      contentLength: body.byteLength,
      checksumSha256
    })
    const wrongLengthBody = Buffer.concat([body, Buffer.from('x')])

    const response = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        'content-length': String(wrongLengthBody.byteLength),
        'x-amz-checksum-sha256': checksumSha256,
        'x-amz-tagging': 'ac-cache=pending'
      },
      body: wrongLengthBody
    })
    const responseBody = await response.text()

    expect(response.status, responseBody).toBe(403)
    expect(responseBody).toContain('SignatureDoesNotMatch')
  })

  it('rejects same-length bytes whose checksum does not match', async () => {
    const signer = createSourceCacheSigner(
      SourceCacheConfigSchema.parse({
        endpoint: ENDPOINT,
        region: 'us-east-1',
        bucket: BUCKET,
        prefix: 'it',
        forcePathStyle: true,
        credentials: {
          source: 'secret',
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET_ACCESS_KEY
        },
        limits: {}
      })
    )!
    const key = `src/contract/${randomUUID()}.bundle`
    const body = Buffer.from(`source-cache-presign-checksum-${randomUUID()}`)
    const checksumSha256 = createHash('sha256').update(body).digest('base64')
    const putUrl = await signer.presignPut(key, {
      contentLength: body.byteLength,
      checksumSha256
    })
    const alteredBody = Buffer.from(body)
    alteredBody[0] = alteredBody[0]! ^ 0xff

    const response = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        'content-length': String(alteredBody.byteLength),
        'x-amz-checksum-sha256': checksumSha256,
        'x-amz-tagging': 'ac-cache=pending'
      },
      body: alteredBody
    })
    const responseBody = await response.text()

    expect(response.status, responseBody).toBe(400)
    expect(responseBody).toContain('XAmzContentChecksumMismatch')
  })
})
