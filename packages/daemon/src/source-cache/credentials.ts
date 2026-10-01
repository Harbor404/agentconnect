import { readFile } from 'node:fs/promises'
import type { SourceCacheCredentials } from './config.js'

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  expiration?: number
}

export type AwsCredentialsProvider = () => Promise<AwsCredentials>

export interface CredentialDependencies {
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  now?: () => Date
}

const FIVE_MINUTES_MS = 5 * 60 * 1000
const IMDS_CONTAINER_HOSTS = new Set(['127.0.0.1', 'localhost', '169.254.170.2', '169.254.170.23'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textField(value: unknown, name: string): string {
  if (!isRecord(value) || typeof value[name] !== 'string' || !value[name]) {
    throw new Error(`source cache credential response is missing ${name}`)
  }
  return value[name]
}

function expirationMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function xmlText(xml: string, name: string): string {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)
  if (!match) throw new Error(`source cache STS response is missing ${name}`)
  return (match[1] ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function staticProvider(credentials: AwsCredentials): AwsCredentialsProvider {
  return async () => credentials
}

function cached(provider: AwsCredentialsProvider, now: () => Date): AwsCredentialsProvider {
  let current: AwsCredentials | undefined
  let inFlight: Promise<AwsCredentials> | undefined

  return async () => {
    const nowMs = now().getTime()
    if (current && (current.expiration === undefined || current.expiration - nowMs > FIVE_MINUTES_MS)) return current
    if (!inFlight) {
      inFlight = provider()
        .then((credentials) => {
          current = credentials
          return credentials
        })
        .finally(() => {
          inFlight = undefined
        })
    }
    return inFlight
  }
}

function environmentCredentials(env: NodeJS.ProcessEnv): AwsCredentials | undefined {
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim()
  if (!accessKeyId || !secretAccessKey) return undefined
  const sessionToken = env.AWS_SESSION_TOKEN?.trim()
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
}

async function webIdentityCredentials(
  env: NodeJS.ProcessEnv,
  region: string,
  fetchImpl: typeof fetch
): Promise<AwsCredentials | undefined> {
  const roleArn = env.AWS_ROLE_ARN?.trim()
  const tokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE?.trim()
  if (!roleArn || !tokenFile) return undefined

  const token = (await readFile(tokenFile, 'utf8')).trim()
  if (!token) throw new Error('source cache web identity token file is empty')
  const sessionName = env.AWS_ROLE_SESSION_NAME?.trim() || 'agentconnect-source-cache'
  const host = region === 'auto' ? 'sts.amazonaws.com' : `sts.${region}.amazonaws.com`
  const endpoint = env.AWS_STS_ENDPOINT?.trim() || `https://${host}`
  const body = new URLSearchParams({
    Action: 'AssumeRoleWithWebIdentity',
    Version: '2011-06-15',
    RoleArn: roleArn,
    RoleSessionName: sessionName,
    WebIdentityToken: token
  })

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`source cache STS AssumeRoleWithWebIdentity failed with HTTP ${response.status}`)

  const expiration = Date.parse(xmlText(text, 'Expiration'))
  return {
    accessKeyId: xmlText(text, 'AccessKeyId'),
    secretAccessKey: xmlText(text, 'SecretAccessKey'),
    sessionToken: xmlText(text, 'SessionToken'),
    ...(Number.isFinite(expiration) ? { expiration } : {})
  }
}

async function authorizationToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const direct = env.AWS_CONTAINER_AUTHORIZATION_TOKEN?.trim()
  if (direct) return direct
  const file = env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE?.trim()
  if (!file) return undefined
  const value = (await readFile(file, 'utf8')).trim()
  return value || undefined
}

async function containerCredentials(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<AwsCredentials | undefined> {
  const relative = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim()
  const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim()
  if (!relative && !full) return undefined

  let endpoint: URL
  if (relative) {
    endpoint = new URL(relative, 'http://169.254.170.2')
    if (endpoint.hostname !== '169.254.170.2') throw new Error('invalid source cache container credential relative URI')
  } else {
    endpoint = new URL(full!)
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      (endpoint.protocol === 'http:' && !IMDS_CONTAINER_HOSTS.has(endpoint.hostname))
    ) {
      throw new Error('source cache container credential URI is not an allowed metadata endpoint')
    }
  }

  const token = await authorizationToken(env)
  const response = await fetchImpl(endpoint, {
    headers: token ? { authorization: token } : undefined
  })
  if (!response.ok) throw new Error(`source cache container credential endpoint failed with HTTP ${response.status}`)
  const payload: unknown = await response.json()
  return {
    accessKeyId: textField(payload, 'AccessKeyId'),
    secretAccessKey: textField(payload, 'SecretAccessKey'),
    sessionToken: textField(payload, 'Token'),
    expiration: expirationMs(isRecord(payload) ? payload.Expiration : undefined)
  }
}

async function serviceAccountCredentials(
  region: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<AwsCredentials> {
  const fromEnvironment = environmentCredentials(env)
  if (fromEnvironment) return fromEnvironment
  const fromWebIdentity = await webIdentityCredentials(env, region, fetchImpl)
  if (fromWebIdentity) return fromWebIdentity
  const fromContainer = await containerCredentials(env, fetchImpl)
  if (fromContainer) return fromContainer
  throw new Error('source cache serviceAccount credentials are unavailable')
}

export function sourceCacheCredentialsProvider(
  credentials: SourceCacheCredentials,
  region: string,
  deps: CredentialDependencies = {}
): AwsCredentialsProvider {
  if (credentials.source === 'secret') {
    return staticProvider({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {})
    })
  }

  const env = deps.env ?? process.env
  const fetchImpl = deps.fetch ?? fetch
  const now = deps.now ?? (() => new Date())
  return cached(() => serviceAccountCredentials(region, env, fetchImpl), now)
}
