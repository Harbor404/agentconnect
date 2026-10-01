import { createHash, createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { SourceCacheConfigSchema, type SourceCacheConfig } from './config.js'
import {
  sourceCacheCredentialsProvider,
  type AwsCredentials,
  type AwsCredentialsProvider,
  type CredentialDependencies
} from './credentials.js'

export const SOURCE_CACHE_GET_TTL_SECONDS = 5 * 60
export const SOURCE_CACHE_PUT_TTL_SECONDS = 15 * 60
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'
const ALGORITHM = 'AWS4-HMAC-SHA256'
const SERVICE = 's3'
const TERMINATOR = 'aws4_request'
const PENDING_TAG = 'ac-cache=pending'

export interface PresignPutInput {
  contentLength: number
  checksumSha256: string
}

export interface SourceCacheSigner {
  presignGet(key: string): Promise<string>
  presignPut(key: string, input: PresignPutInput): Promise<string>
}

export interface SourceCacheSignerDependencies extends CredentialDependencies {
  credentialsProvider?: AwsCredentialsProvider
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest()
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function canonicalPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeRfc3986(segment))
    .join('/')
}

function canonicalQuery(parameters: ReadonlyArray<readonly [string, string]>): string {
  return parameters
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName !== rightName) return leftName < rightName ? -1 : 1
      if (leftValue === rightValue) return 0
      return leftValue < rightValue ? -1 : 1
    })
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
}

function formatAmzDate(date: Date): { timestamp: string; day: string } {
  if (!Number.isFinite(date.getTime())) throw new Error('source cache signer clock returned an invalid date')
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { timestamp, day: timestamp.slice(0, 8) }
}

function objectKey(prefix: string, key: string): string {
  if (!key || key !== key.trim() || key.startsWith('/') || key.endsWith('/'))
    throw new Error('invalid source cache object key')
  const segments = key.split('/')
  if (
    segments.some(
      (segment) =>
        !segment || segment === '.' || segment === '..' || segment.includes('\\') || /[\0-\x1f\x7f]/.test(segment)
    )
  ) {
    throw new Error('invalid source cache object key')
  }
  return prefix ? `${prefix}/${key}` : key
}

function checksumSha256(value: string): string {
  const normalized = value.trim()
  const decoded = Buffer.from(normalized, 'base64')
  if (decoded.length !== 32 || decoded.toString('base64') !== normalized) {
    throw new Error('source cache PUT checksum must be a base64-encoded SHA-256 digest')
  }
  return normalized
}

function contentLength(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('source cache PUT Content-Length must be a positive integer')
  return String(value)
}

function signingKey(secretAccessKey: string, day: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), SERVICE), TERMINATOR)
}

class AwsSigV4SourceCacheSigner implements SourceCacheSigner {
  private readonly endpoint: URL

  constructor(
    private readonly config: SourceCacheConfig,
    private readonly credentials: AwsCredentialsProvider,
    private readonly now: () => Date
  ) {
    this.endpoint = new URL(config.endpoint)
  }

  async presignGet(key: string): Promise<string> {
    return this.presign('GET', key, {}, SOURCE_CACHE_GET_TTL_SECONDS)
  }

  async presignPut(key: string, input: PresignPutInput): Promise<string> {
    return this.presign(
      'PUT',
      key,
      {
        'content-length': contentLength(input.contentLength),
        'x-amz-checksum-sha256': checksumSha256(input.checksumSha256),
        'x-amz-tagging': PENDING_TAG
      },
      SOURCE_CACHE_PUT_TTL_SECONDS
    )
  }

  private async presign(
    method: 'GET' | 'PUT',
    key: string,
    headers: Record<string, string>,
    expires: number
  ): Promise<string> {
    const credentials: AwsCredentials = await this.credentials()
    const fullKey = objectKey(this.config.prefix, key)
    const request = this.objectRequest(fullKey)
    const { timestamp, day } = formatAmzDate(this.now())
    const scope = `${day}/${this.config.region}/${SERVICE}/${TERMINATOR}`
    const canonicalHeaders = {
      host: request.host,
      ...headers
    }
    const signedHeaderNames = Object.keys(canonicalHeaders).sort()
    const signedHeaders = signedHeaderNames.join(';')
    const parameters: Array<readonly [string, string]> = [
      ['X-Amz-Algorithm', ALGORITHM],
      ['X-Amz-Credential', `${credentials.accessKeyId}/${scope}`],
      ['X-Amz-Date', timestamp],
      ['X-Amz-Expires', String(expires)],
      ['X-Amz-SignedHeaders', signedHeaders],
      ...(credentials.sessionToken ? ([['X-Amz-Security-Token', credentials.sessionToken]] as const) : [])
    ]
    const query = canonicalQuery(parameters)
    const canonicalHeaderBlock = signedHeaderNames
      .map((name) => `${name}:${canonicalHeaders[name as keyof typeof canonicalHeaders].trim().replace(/\s+/g, ' ')}\n`)
      .join('')
    const canonicalRequest = [method, request.path, query, canonicalHeaderBlock, signedHeaders, UNSIGNED_PAYLOAD].join(
      '\n'
    )
    const stringToSign = [ALGORITHM, timestamp, scope, sha256Hex(canonicalRequest)].join('\n')
    const signature = createHmac('sha256', signingKey(credentials.secretAccessKey, day, this.config.region))
      .update(stringToSign, 'utf8')
      .digest('hex')

    return `${this.endpoint.protocol}//${request.host}${request.path}?${query}&X-Amz-Signature=${signature}`
  }

  private objectRequest(key: string): { host: string; path: string } {
    const ipLiteral = this.endpoint.hostname.startsWith('[') || isIP(this.endpoint.hostname) !== 0
    const pathStyle = this.config.forcePathStyle || ipLiteral || this.config.bucket.includes('.')
    const path = pathStyle ? `/${this.config.bucket}/${key}` : `/${key}`
    return {
      host: pathStyle ? this.endpoint.host : `${this.config.bucket}.${this.endpoint.host}`,
      path: canonicalPath(path)
    }
  }
}

/** The disabled default allocates no signer, credentials provider, or network state. */
export function createSourceCacheSigner(
  config: SourceCacheConfig | undefined,
  deps: SourceCacheSignerDependencies = {}
): SourceCacheSigner | undefined {
  if (!config) return undefined
  const parsed = SourceCacheConfigSchema.parse(config)
  const now = deps.now ?? (() => new Date())
  const credentials =
    deps.credentialsProvider ??
    sourceCacheCredentialsProvider(parsed.credentials, parsed.region, { env: deps.env, fetch: deps.fetch, now })
  return new AwsSigV4SourceCacheSigner(parsed, credentials, now)
}
