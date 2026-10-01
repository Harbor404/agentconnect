import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigSchema } from '../src/config/config-schema.js'
import { loadConfig } from '../src/config/load-config.js'
import {
  SOURCE_CACHE_ACCESS_KEY_ID_FILE,
  SOURCE_CACHE_CONFIG_PATH,
  SOURCE_CACHE_SECRET_ACCESS_KEY_FILE,
  SourceCacheConfigSchema,
  SourceCacheDocumentSchema,
  readSourceCacheConfig
} from '../src/source-cache/config.js'

function tmpRoot(extra: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-source-cache-cfg-'))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, ...extra }))
  return root
}

function writeDocument(document: unknown, path = join(tmpRoot(), 'source-cache.json')): string {
  writeFileSync(path, JSON.stringify(document))
  return path
}

function writeSecretFiles(root: string, values: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string } = {}) {
  const dir = join(root, 'credentials')
  mkdirSync(dir, { recursive: true })
  const files = {
    accessKeyIdFile: join(dir, 'access-key-id'),
    secretAccessKeyFile: join(dir, 'secret-access-key'),
    sessionTokenFile: join(dir, 'session-token')
  }
  writeFileSync(files.accessKeyIdFile, values.accessKeyId ?? 'AKIDEXAMPLE')
  writeFileSync(files.secretAccessKeyFile, values.secretAccessKey ?? 'secret-example')
  if (values.sessionToken === undefined) {
    const { sessionTokenFile: _sessionTokenFile, ...withoutSessionToken } = files
    return withoutSessionToken
  }
  writeFileSync(files.sessionTokenFile, values.sessionToken)
  return files
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('source cache member configuration', () => {
  it('is absent, and therefore a no-op, when the pool member has no document', () => {
    expect(readSourceCacheConfig(join(tmpRoot(), 'missing.json'))).toBeUndefined()
  })

  it('keeps the feature out of the shared daemon Config and ignores source-cache environment', () => {
    expect(
      ConfigSchema.parse({
        version: 1,
        sourceCache: {
          endpoint: 'https://cache.example.test',
          bucket: 'agentconnect-cache',
          credentials: { source: 'serviceAccount' }
        }
      })
    ).not.toHaveProperty('sourceCache')

    vi.stubEnv(
      'AC_SOURCE_CACHE_CONFIG',
      JSON.stringify({
        endpoint: 'not a url',
        bucket: 'agentconnect-cache',
        credentialSource: 'serviceAccount'
      })
    )
    expect(loadConfig({ root: tmpRoot() })).not.toHaveProperty('sourceCache')
  })

  it('ignores a sourceCache arm in a daemon config file instead of making it a second configuration path', () => {
    expect(
      loadConfig({
        root: tmpRoot({
          sourceCache: {
            endpoint: 'https://cache.example.test',
            bucket: 'agentconnect-cache',
            credentials: { source: 'serviceAccount' }
          }
        })
      })
    ).not.toHaveProperty('sourceCache')
  })

  it('resolves the member document defaults for a ServiceAccount identity', () => {
    const root = tmpRoot()
    const config = readSourceCacheConfig(
      writeDocument(
        {
          version: 1,
          endpoint: 'https://cache.example.test',
          bucket: 'agentconnect-cache',
          credentials: { source: 'serviceAccount' }
        },
        join(root, 'source-cache.json')
      )
    )

    expect(config).toEqual({
      endpoint: 'https://cache.example.test',
      region: 'us-east-1',
      bucket: 'agentconnect-cache',
      prefix: '',
      forcePathStyle: false,
      credentials: { source: 'serviceAccount' },
      limits: {
        maxBundleBytes: 2 * 1024 ** 3,
        orgTotalBytes: 20 * 1024 ** 3,
        pendingReservationMs: 60 * 60 * 1000,
        pendingObjectTtlDays: 2,
        unreferencedObjectTtlDays: 7,
        unreadPointerTtlDays: 30
      }
    })
  })

  it('resolves a two-key Secret document without requiring a session token', () => {
    const root = tmpRoot()
    const files = writeSecretFiles(root)
    const config = readSourceCacheConfig(
      writeDocument(
        {
          version: 1,
          endpoint: 'https://cache.example.test',
          region: 'auto',
          bucket: 'agentconnect-cache',
          prefix: '/install-a/',
          forcePathStyle: true,
          credentials: { source: 'secret', ...files },
          limits: { maxBundleBytes: 3_000, orgTotalBytes: 30_000 }
        },
        join(root, 'source-cache.json')
      )
    )

    expect(config).toEqual({
      endpoint: 'https://cache.example.test',
      region: 'auto',
      bucket: 'agentconnect-cache',
      prefix: 'install-a',
      forcePathStyle: true,
      credentials: {
        source: 'secret',
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'secret-example'
      },
      limits: {
        maxBundleBytes: 3_000,
        orgTotalBytes: 30_000,
        pendingReservationMs: 60 * 60 * 1000,
        pendingObjectTtlDays: 2,
        unreferencedObjectTtlDays: 7,
        unreadPointerTtlDays: 30
      }
    })
  })

  it('reads an optional session token only when the document names its file', () => {
    const root = tmpRoot()
    const files = writeSecretFiles(root, { sessionToken: 'session-example' })
    const config = readSourceCacheConfig(
      writeDocument(
        {
          version: 1,
          endpoint: 'https://cache.example.test',
          bucket: 'agentconnect-cache',
          credentials: { source: 'secret', ...files }
        },
        join(root, 'source-cache.json')
      )
    )

    expect(config?.credentials).toEqual({
      source: 'secret',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret-example',
      sessionToken: 'session-example'
    })
  })

  it('rejects an incomplete or malformed member document rather than disabling silently', () => {
    const path = writeDocument({
      version: 1,
      endpoint: 'https://cache.example.test',
      bucket: 'agentconnect-cache',
      credentials: { source: 'secret' }
    })
    expect(() => readSourceCacheConfig(path)).toThrow(/invalid source cache configuration/i)
    expect(() => readSourceCacheConfig(writeDocument({ endpoint: 'not a url' }))).toThrow(
      /invalid source cache configuration/i
    )
  })

  it('does not expose inline static credentials or environment-variable arms in the member schema', () => {
    const parsed = SourceCacheDocumentSchema.safeParse({
      version: 1,
      endpoint: 'https://cache.example.test',
      bucket: 'agentconnect-cache',
      credentials: {
        source: 'secret',
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'secret-example'
      }
    })
    expect(parsed.success).toBe(false)

    expect(
      SourceCacheConfigSchema.safeParse({
        endpoint: 'https://cache.example.test',
        region: 'auto',
        bucket: 'agentconnect-cache',
        credentials: { source: 'serviceAccount' },
        limits: {}
      }).success
    ).toBe(false)
  })

  it('uses fixed member-config paths matching the chart mounts', () => {
    expect(SOURCE_CACHE_CONFIG_PATH).toBe('/var/run/ac-source-cache/config.json')
    expect(SOURCE_CACHE_ACCESS_KEY_ID_FILE).toBe('/var/run/ac-source-cache-credentials/access-key-id')
    expect(SOURCE_CACHE_SECRET_ACCESS_KEY_FILE).toBe('/var/run/ac-source-cache-credentials/secret-access-key')
  })
})
