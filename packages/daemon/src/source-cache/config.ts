import { z } from 'zod'

/** The one environment document the Helm chart renders into a pool member. */
export const SOURCE_CACHE_CONFIG_ENV = 'AC_SOURCE_CACHE_CONFIG'
/** Static S3 credentials are projected by Secret reference, never inline in the config document. */
export const SOURCE_CACHE_ACCESS_KEY_ID_ENV = 'AC_SOURCE_CACHE_ACCESS_KEY_ID'
export const SOURCE_CACHE_SECRET_ACCESS_KEY_ENV = 'AC_SOURCE_CACHE_SECRET_ACCESS_KEY'
export const SOURCE_CACHE_SESSION_TOKEN_ENV = 'AC_SOURCE_CACHE_SESSION_TOKEN'

const GIB = 1024 ** 3
const HOUR_MS = 60 * 60 * 1000

export const SOURCE_CACHE_LIMIT_DEFAULTS = {
  maxBundleBytes: 2 * GIB,
  orgTotalBytes: 20 * GIB,
  pendingReservationMs: HOUR_MS,
  pendingObjectTtlDays: 2,
  unreferencedObjectTtlDays: 7,
  unreadPointerTtlDays: 30
} as const

/** Section 10 defaults. The data plane owns enforcement; config validation rejects values
 * that cannot be represented or would invert an invariant. */
export const SourceCacheLimitsSchema = z
  .object({
    maxBundleBytes: z.number().int().positive().default(SOURCE_CACHE_LIMIT_DEFAULTS.maxBundleBytes),
    orgTotalBytes: z.number().int().positive().default(SOURCE_CACHE_LIMIT_DEFAULTS.orgTotalBytes),
    pendingReservationMs: z.number().int().positive().default(SOURCE_CACHE_LIMIT_DEFAULTS.pendingReservationMs),
    pendingObjectTtlDays: z.number().int().positive().default(SOURCE_CACHE_LIMIT_DEFAULTS.pendingObjectTtlDays),
    unreferencedObjectTtlDays: z
      .number()
      .int()
      .positive()
      .default(SOURCE_CACHE_LIMIT_DEFAULTS.unreferencedObjectTtlDays),
    unreadPointerTtlDays: z.number().int().positive().default(SOURCE_CACHE_LIMIT_DEFAULTS.unreadPointerTtlDays)
  })
  .strict()

const BucketName = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, 'invalid S3 bucket name')
  .refine((value) => !value.includes('..') && !value.includes('.-') && !value.includes('-.'), 'invalid S3 bucket name')

const Prefix = z
  .string()
  .max(1024)
  .transform((value, ctx) => {
    const normalized = value.replace(/^\/+|\/+$/g, '')
    if (
      (normalized !== '' &&
        normalized
          .split('/')
          .some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\\'))) ||
      /[\0-\x1f\x7f]/.test(normalized)
    ) {
      ctx.addIssue({ code: 'custom', message: 'invalid source cache prefix' })
      return z.NEVER
    }
    return normalized
  })

const Endpoint = z
  .string()
  .url()
  .transform((value, ctx) => {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      ctx.addIssue({
        code: 'custom',
        message: 'source cache endpoint must be an origin without credentials, path, query, or fragment'
      })
      return z.NEVER
    }
    return url.origin
  })

const ServiceAccountCredentials = z.object({ source: z.literal('serviceAccount') }).strict()
const SecretCredentials = z
  .object({
    source: z.literal('secret'),
    accessKeyId: z
      .string()
      .min(1)
      .max(16 * 1024),
    secretAccessKey: z
      .string()
      .min(1)
      .max(16 * 1024),
    sessionToken: z
      .string()
      .min(1)
      .max(64 * 1024)
      .optional()
  })
  .strict()

export const SourceCacheCredentialsSchema = z.discriminatedUnion('source', [
  ServiceAccountCredentials,
  SecretCredentials
])

const SourceCacheBaseSchema = z
  .object({
    endpoint: Endpoint,
    region: z.string().trim().min(1).max(64).default('auto'),
    bucket: BucketName,
    prefix: Prefix.default(''),
    forcePathStyle: z.boolean().default(false),
    limits: SourceCacheLimitsSchema.default(SOURCE_CACHE_LIMIT_DEFAULTS)
  })
  .strict()

/** The daemon's validated shape. Presence means the feature is enabled; absence is the no-op. */
export const SourceCacheConfigSchema = SourceCacheBaseSchema.extend({
  credentials: SourceCacheCredentialsSchema
}).strict()

export type SourceCacheConfig = z.infer<typeof SourceCacheConfigSchema>
export type SourceCacheCredentials = SourceCacheConfig['credentials']

const SourceCacheEnvironmentSchema = SourceCacheBaseSchema.extend({
  credentialSource: z.enum(['serviceAccount', 'secret'])
}).strict()

function requiredSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required when source cache credentialSource=secret`)
  return value
}

/** Parse the member-only Helm document. Blank means the feature is off; malformed means
 * configuration is wrong and must be fixed rather than silently disabling the cache. */
export function sourceCacheConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SourceCacheConfig | undefined {
  const raw = env[SOURCE_CACHE_CONFIG_ENV]?.trim()
  if (!raw) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${SOURCE_CACHE_CONFIG_ENV} must be valid JSON`)
  }

  const document = SourceCacheEnvironmentSchema.safeParse(parsed)
  if (!document.success) throw new Error(`${SOURCE_CACHE_CONFIG_ENV}: ${document.error.message}`)

  const credentials =
    document.data.credentialSource === 'secret'
      ? {
          source: 'secret' as const,
          accessKeyId: requiredSecret(env, SOURCE_CACHE_ACCESS_KEY_ID_ENV),
          secretAccessKey: requiredSecret(env, SOURCE_CACHE_SECRET_ACCESS_KEY_ENV),
          ...(env[SOURCE_CACHE_SESSION_TOKEN_ENV]?.trim()
            ? { sessionToken: env[SOURCE_CACHE_SESSION_TOKEN_ENV]!.trim() }
            : {})
        }
      : { source: 'serviceAccount' as const }

  const { credentialSource: _credentialSource, ...base } = document.data
  return SourceCacheConfigSchema.parse({ ...base, credentials })
}
