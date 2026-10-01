import { describe, expect, it } from 'vitest'
import {
  createSourceCacheSigner,
  SOURCE_CACHE_GET_TTL_SECONDS,
  SOURCE_CACHE_PUT_TTL_SECONDS
} from '../src/source-cache/signer.js'
import { SourceCacheConfigSchema, type SourceCacheConfig } from '../src/source-cache/config.js'

const NOW = new Date('2026-10-01T15:04:05.000Z')

function config(overrides: Partial<SourceCacheConfig> = {}): SourceCacheConfig {
  return SourceCacheConfigSchema.parse({
    endpoint: 'https://cache.example.test',
    region: 'us-east-1',
    bucket: 'agentconnect-cache',
    prefix: 'install-a',
    forcePathStyle: true,
    credentials: {
      source: 'secret',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
    },
    limits: {},
    ...overrides
  })
}

describe('source cache presigner', () => {
  it('returns no signer at all when the feature is disabled', () => {
    expect(createSourceCacheSigner(undefined)).toBeUndefined()
  })

  it('presigns a GET for five minutes with only host in the signed headers', async () => {
    const signer = createSourceCacheSigner(config(), { now: () => NOW })!
    const url = new URL(await signer.presignGet('src/org/anon/repo/refs/hash/full/latest'))

    expect(url.origin).toBe('https://cache.example.test')
    expect(url.pathname).toBe('/agentconnect-cache/install-a/src/org/anon/repo/refs/hash/full/latest')
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKIDEXAMPLE/20261001/us-east-1/s3/aws4_request')
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261001T150405Z')
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(SOURCE_CACHE_GET_TTL_SECONDS))
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('presigns a PUT for fifteen minutes and binds length, checksum, and pending tagging', async () => {
    const signer = createSourceCacheSigner(config(), { now: () => NOW })!
    const url = new URL(
      await signer.presignPut('src/org/anon/repo/bundles/00000000-0000-4000-8000-000000000001.bundle', {
        contentLength: 12_345,
        checksumSha256: '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='
      })
    )

    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(SOURCE_CACHE_PUT_TTL_SECONDS))
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host;x-amz-checksum-sha256;x-amz-tagging')
  })

  it('encodes an object path exactly once', async () => {
    const signer = createSourceCacheSigner(config(), { now: () => NOW })!
    const url = new URL(await signer.presignGet('src/org/anon/repo/a file.bundle'))

    expect(url.pathname).toBe('/agentconnect-cache/install-a/src/org/anon/repo/a%20file.bundle')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('fixes GET and PUT at the design lifetimes and exposes no per-call override', async () => {
    const signer = createSourceCacheSigner(config(), { now: () => NOW })!

    const get = new URL(await signer.presignGet('src/org/anon/repo/refs/hash/full/latest'))
    expect(get.searchParams.get('X-Amz-Expires')).toBe('300')

    const put = new URL(
      await signer.presignPut('src/org/anon/repo/bundles/x.bundle', {
        contentLength: 1,
        checksumSha256: '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='
      })
    )
    expect(put.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(SOURCE_CACHE_GET_TTL_SECONDS).toBe(300)
    expect(SOURCE_CACHE_PUT_TTL_SECONDS).toBe(900)
  })

  it('uses the Kubernetes service account credential chain without embedding credentials in config', async () => {
    const signer = createSourceCacheSigner(
      config({
        credentials: { source: 'serviceAccount' }
      }),
      {
        now: () => NOW,
        env: {
          AWS_ACCESS_KEY_ID: 'SERVICEACCOUNT_KEY',
          AWS_SECRET_ACCESS_KEY: 'SERVICEACCOUNT_SECRET',
          AWS_SESSION_TOKEN: 'SERVICEACCOUNT_TOKEN'
        }
      }
    )!
    const url = new URL(await signer.presignGet('src/org/anon/repo/refs/hash/full/latest'))

    expect(url.searchParams.get('X-Amz-Credential')).toContain('SERVICEACCOUNT_KEY/')
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('SERVICEACCOUNT_TOKEN')
  })

  it('uses path-style addressing for an IPv6 endpoint', async () => {
    const signer = createSourceCacheSigner(
      config({
        endpoint: 'http://[::1]:9000',
        forcePathStyle: false
      }),
      { now: () => NOW }
    )!
    const url = new URL(await signer.presignGet('src/org/anon/repo/refs/hash/full/latest'))

    expect(url.host).toBe('[::1]:9000')
    expect(url.pathname).toBe('/agentconnect-cache/install-a/src/org/anon/repo/refs/hash/full/latest')
  })

  it('rejects unsafe object keys and malformed checksums before signing', async () => {
    const signer = createSourceCacheSigner(config(), { now: () => NOW })!
    await expect(signer.presignGet('../escape')).rejects.toThrow(/object key/i)
    await expect(
      signer.presignPut('src/org/anon/repo/bundles/x.bundle', {
        contentLength: 1,
        checksumSha256: 'not-a-sha256'
      })
    ).rejects.toThrow(/checksum/i)
  })
})
