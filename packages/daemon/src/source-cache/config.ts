import { readFileSync } from 'node:fs'
import { z } from 'zod'

/** The pool member's fixed Secret/ConfigMap mount. It is never read by the shared daemon Config loader. */
export const SOURCE_CACHE_CONFIG_PATH = '/var/run/ac-source-cache/config.json'
/** Secret-volume paths for static credentials. Keeping these files member-local avoids process-env inheritance. */
export const SOURCE_CACHE_ACCESS_KEY_ID_FILE = '/var/run/ac-source-cache-credentials/access-key-id'
export const SOURCE_CACHE_SECRET_ACCESS_KEY_FILE = '/var/run/ac-source-cache-credentials/secret-access-key'
export const SOURCE_CACHE_SESSION_TOKEN_FILE = '/var/run/ac-source-cache-credentials/session-token'

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

const SourceCacheBaseShape = {
  endpoint: Endpoint,
  // `auto` is an R2-style value and has no AWS STS region meaning. Keep the default concrete so
  // the default ServiceAccount arm remains a valid AWS identity configuration.
  region: z.string().trim().min(1).max(64).default('us-east-1'),
  bucket: BucketName,
  prefix: Prefix.default(''),
  forcePathStyle: z.boolean().default(false),
  limits: SourceCacheLimitsSchema.default(SOURCE_CACHE_LIMIT_DEFAULTS)
} as const

const sourceCacheRegionRefinement = (
  value: { region: string; credentials: { source: 'serviceAccount' | 'secret' } },
  ctx: z.RefinementCtx
): void => {
  if (value.credentials.source === 'serviceAccount' && value.region === 'auto') {
    ctx.addIssue({
      code: 'custom',
      path: ['region'],
      message: 'serviceAccount credentials require a concrete AWS region; region "auto" is only valid with secret credentials'
    })
  }
}

/** The resolved member shape. Presence means the feature is enabled; absence is the no-op. */
export const SourceCacheConfigSchema = z
  .object({
    ...SourceCacheBaseShape,
    credentials: SourceCacheCredentialsSchema
  })
  .strict()
  .superRefine(sourceCacheRegionRefinement)

export type SourceCacheConfig = z.infer<typeof SourceCacheConfigSchema>
export type SourceCacheCredentials = SourceCacheConfig['credentials']

const CredentialFilePath = z
  .string()
  .min(1)
  .refine((value) => value.startsWith('/'), 'credential file paths must be absolute')

const SecretFileCredentials = z
  .object({
    source: z.literal('secret'),
    accessKeyIdFile: CredentialFilePath,
    secretAccessKeyFile: CredentialFilePath,
    sessionTokenFile: CredentialFilePath.optional()
  })
  .strict()

export const SourceCacheDocumentSchema = z
  .object({
    version: z.literal(1),
    ...SourceCacheBaseShape,
    credentials: z.discriminatedUnion('source', [ServiceAccountCredentials, SecretFileCredentials])
  })
  .strict()
  .superRefine(sourceCacheRegionRefinement)

export type SourceCacheDocument = z.infer<typeof SourceCacheDocumentSchema>

function readCredentialFile(path: string, label: string): string {
  try {
    const value = readFileSync(path, 'utf8').trim()
    if (!value) throw new Error('empty')
    return value
  } catch {
    throw new Error(`source cache ${label} file is not readable at ${path}`)
  }
}

/** Read the member-only document. A missing mount is the disabled no-op; a present malformed
 * document fails startup instead of silently issuing unsigned or differently-scoped URLs. */
export function readSourceCacheConfig(path = SOURCE_CACHE_CONFIG_PATH): SourceCacheConfig | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`source cache configuration is not readable at ${path}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`source cache configuration is not valid JSON at ${path}`)
  }

  const parsed = SourceCacheDocumentSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(
      `invalid source cache configuration at ${path}: ${issue?.path.join('.') || 'document'} ${issue?.message}`
    )
  }

  const { version: _version, credentials, ...base } = parsed.data
  const resolvedCredentials: SourceCacheCredentials =
    credentials.source === 'secret'
      ? {
          source: 'secret',
          accessKeyId: readCredentialFile(credentials.accessKeyIdFile, 'access key id'),
          secretAccessKey: readCredentialFile(credentials.secretAccessKeyFile, 'secret access key'),
          ...(credentials.sessionTokenFile
            ? { sessionToken: readCredentialFile(credentials.sessionTokenFile, 'session token') }
            : {})
        }
      : { source: 'serviceAccount' }

  return SourceCacheConfigSchema.parse({ ...base, credentials: resolvedCredentials })
}
