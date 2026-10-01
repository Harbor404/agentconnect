import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigSchema } from '../src/config/config-schema.js'
import { loadConfig } from '../src/config/load-config.js'
import {
  SOURCE_CACHE_ACCESS_KEY_ID_ENV,
  SOURCE_CACHE_CONFIG_ENV,
  SOURCE_CACHE_SECRET_ACCESS_KEY_ENV,
  SOURCE_CACHE_SESSION_TOKEN_ENV
} from '../src/source-cache/config.js'

const SOURCE_CACHE_ENV_NAMES = [
  SOURCE_CACHE_CONFIG_ENV,
  SOURCE_CACHE_ACCESS_KEY_ID_ENV,
  SOURCE_CACHE_SECRET_ACCESS_KEY_ENV,
  SOURCE_CACHE_SESSION_TOKEN_ENV
] as const

const saved = new Map<string, string | undefined>()

function withSourceCacheEnv(
  values: Partial<Record<(typeof SOURCE_CACHE_ENV_NAMES)[number], string>>,
  run: () => void
): void {
  for (const name of SOURCE_CACHE_ENV_NAMES) {
    if (!saved.has(name)) saved.set(name, process.env[name])
    delete process.env[name]
  }
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    run()
  } finally {
    for (const name of SOURCE_CACHE_ENV_NAMES) {
      const value = saved.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-source-cache-cfg-'))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1 }))
  return root
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved.clear()
})

describe('source cache daemon configuration', () => {
  it('is absent, and therefore a no-op, when no bucket is configured', () => {
    withSourceCacheEnv({}, () => {
      const cfg = loadConfig({ root: tmpRoot() })
      expect(cfg.sourceCache).toBeUndefined()
    })
  })

  it('validates the member-only environment document and resolves Secret credentials', () => {
    withSourceCacheEnv(
      {
        [SOURCE_CACHE_CONFIG_ENV]: JSON.stringify({
          endpoint: 'https://cache.example.test',
          region: 'us-east-1',
          bucket: 'agentconnect-cache',
          prefix: '/install-a/',
          forcePathStyle: false,
          credentialSource: 'secret',
          limits: {
            maxBundleBytes: 3_000,
            orgTotalBytes: 30_000,
            pendingReservationMs: 7_200_000,
            pendingObjectTtlDays: 3,
            unreferencedObjectTtlDays: 8,
            unreadPointerTtlDays: 31
          }
        }),
        [SOURCE_CACHE_ACCESS_KEY_ID_ENV]: 'AKIDEXAMPLE',
        [SOURCE_CACHE_SECRET_ACCESS_KEY_ENV]: 'secret-example',
        [SOURCE_CACHE_SESSION_TOKEN_ENV]: 'session-example'
      },
      () => {
        const cfg = loadConfig({ root: tmpRoot() })
        expect(cfg.sourceCache).toEqual({
          endpoint: 'https://cache.example.test',
          region: 'us-east-1',
          bucket: 'agentconnect-cache',
          prefix: 'install-a',
          forcePathStyle: false,
          credentials: {
            source: 'secret',
            accessKeyId: 'AKIDEXAMPLE',
            secretAccessKey: 'secret-example',
            sessionToken: 'session-example'
          },
          limits: {
            maxBundleBytes: 3_000,
            orgTotalBytes: 30_000,
            pendingReservationMs: 7_200_000,
            pendingObjectTtlDays: 3,
            unreferencedObjectTtlDays: 8,
            unreadPointerTtlDays: 31
          }
        })
      }
    )
  })

  it("applies the design's defaults, including the ServiceAccount credential source", () => {
    withSourceCacheEnv(
      {
        [SOURCE_CACHE_CONFIG_ENV]: JSON.stringify({
          endpoint: 'https://cache.example.test',
          bucket: 'agentconnect-cache',
          credentialSource: 'serviceAccount'
        })
      },
      () => {
        const cfg = loadConfig({ root: tmpRoot() })
        expect(cfg.sourceCache?.credentials).toEqual({ source: 'serviceAccount' })
        expect(cfg.sourceCache?.region).toBe('auto')
        expect(cfg.sourceCache?.prefix).toBe('')
        expect(cfg.sourceCache?.forcePathStyle).toBe(false)
        expect(cfg.sourceCache?.limits).toEqual({
          maxBundleBytes: 2 * 1024 ** 3,
          orgTotalBytes: 20 * 1024 ** 3,
          pendingReservationMs: 60 * 60 * 1000,
          pendingObjectTtlDays: 2,
          unreferencedObjectTtlDays: 7,
          unreadPointerTtlDays: 30
        })
      }
    )
  })

  it('rejects malformed config rather than disabling silently', () => {
    withSourceCacheEnv(
      {
        [SOURCE_CACHE_CONFIG_ENV]: JSON.stringify({
          endpoint: 'not a url',
          bucket: 'agentconnect-cache',
          credentialSource: 'serviceAccount'
        })
      },
      () => {
        expect(() => loadConfig({ root: tmpRoot() })).toThrow(SOURCE_CACHE_CONFIG_ENV)
      }
    )
  })

  it('requires both static keys when the credential source is a Secret', () => {
    withSourceCacheEnv(
      {
        [SOURCE_CACHE_CONFIG_ENV]: JSON.stringify({
          endpoint: 'https://cache.example.test',
          bucket: 'agentconnect-cache',
          credentialSource: 'secret'
        }),
        [SOURCE_CACHE_ACCESS_KEY_ID_ENV]: 'AKIDEXAMPLE'
      },
      () => {
        expect(() => loadConfig({ root: tmpRoot() })).toThrow(SOURCE_CACHE_SECRET_ACCESS_KEY_ENV)
      }
    )
  })

  it('accepts a file document and keeps the environment out of the direct schema', () => {
    expect(ConfigSchema.parse({ version: 1 })).not.toHaveProperty('sourceCache')
    expect(
      ConfigSchema.parse({
        version: 1,
        sourceCache: {
          endpoint: 'https://cache.example.test',
          region: 'auto',
          bucket: 'agentconnect-cache',
          prefix: '',
          forcePathStyle: true,
          credentials: { source: 'serviceAccount' },
          limits: {}
        }
      }).sourceCache
    ).toMatchObject({
      endpoint: 'https://cache.example.test',
      forcePathStyle: true,
      credentials: { source: 'serviceAccount' },
      limits: { maxBundleBytes: 2 * 1024 ** 3 }
    })
  })
})
