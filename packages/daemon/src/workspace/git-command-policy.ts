import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

// Share the daemon's workspace Git command inventory across sandbox transports.
export const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'add',
  'branch',
  'bundle',
  'check-ref-format',
  'checkout',
  'clean',
  'clone',
  'commit',
  'config',
  'diff',
  'fetch',
  'log',
  'ls-files',
  'ls-remote',
  'pull',
  'push',
  'remote',
  'reset',
  'rev-list',
  'rev-parse',
  'show-ref',
  'status',
  'symbolic-ref',
  'update-ref',
  'worktree'
])

// Refuse execution options in every accepted spelling.
const REFUSED_LONG_OPTIONS = [
  '--config', // --config=k=v
  '--config-env',
  '--exec-path', // relocates git's helper binaries
  '--upload-pack',
  '--receive-pack'
]
const REFUSED_SHORT_ARGUMENT = /^-c/ // ad-hoc config in any spelling: -c k=v, -ck=v

function optionPart(argument: string): string {
  const equals = argument.indexOf('=')
  return equals === -1 ? argument : argument.slice(0, equals)
}

function isRefusedArgument(argument: string): boolean {
  if (REFUSED_SHORT_ARGUMENT.test(argument)) return true
  const option = optionPart(argument)
  return REFUSED_LONG_OPTIONS.some(
    (refused) => option.length > 2 && (refused.startsWith(option) || option.startsWith(refused))
  )
}

// These spellings reach execution only for the named subcommand.
const REFUSED_SUBCOMMAND_ARGUMENT: Record<string, RegExp[]> = {
  // Admitted only for the workspace sync's `checkout --no-track -B <branch> <ref>`; every form that discards or restores files stays out.
  checkout: [
    /^-f$/,
    /^--force$/,
    /^--$/,
    /^-m$/,
    /^--merge$/,
    /^-p$/,
    /^--patch$/,
    /^--ours$/,
    /^--theirs$/,
    /^--orphan/,
    /^--detach$/
  ],
  clone: [/^-u/],
  config: [/^-e$/, /^--edit/]
}

export class ExecRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecRefusedError'
  }
}

export interface GitCommandPolicyOptions {
  /** The only directory in which a write-back bundle may be created. */
  stagingRoot: string
}

const BUNDLE_URI = '--bundle-uri'
const BUNDLE_FILTER = '--filter=blob:none'
const MAX_BUNDLE_URI_LENGTH = 8 * 1024
const MAX_REF_LENGTH = 1024
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const SAFE_BUNDLE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/
const SAFE_REF_COMPONENT = /^[\p{L}\p{N}._-]+$/u

function refuse(message: string): never {
  throw new ExecRefusedError(message)
}

function validateBundleUri(uri: string, subcommand: string): void {
  if (subcommand !== 'clone') refuse(`${BUNDLE_URI} is only permitted for git clone`)
  if (uri.length === 0 || uri.length > MAX_BUNDLE_URI_LENGTH || CONTROL_CHARACTER.test(uri) || /\s/.test(uri)) {
    refuse(`${BUNDLE_URI} must be a bounded HTTPS URL`)
  }
  if (!uri.startsWith('https://')) refuse(`${BUNDLE_URI} must use https://`)
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    refuse(`${BUNDLE_URI} is not a valid URL`)
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    refuse(`${BUNDLE_URI} must be a credential-free HTTPS URL without a fragment`)
  }
}

function validateBundleUris(args: string[]): void {
  const [subcommand, ...rest] = args
  let seen = false
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!
    if (argument === BUNDLE_URI) {
      const value = rest[index + 1]
      if (value === undefined) refuse(`${BUNDLE_URI} requires an HTTPS URL`)
      validateBundleUri(value, subcommand ?? '')
      seen = true
      index += 1
      continue
    }
    if (argument.startsWith(`${BUNDLE_URI}=`)) {
      validateBundleUri(argument.slice(BUNDLE_URI.length + 1), subcommand ?? '')
      seen = true
      continue
    }
    const option = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument
    // Git accepts unique long-option prefixes. `--bu=` reaches the same clone option as the full
    // spelling, so accepting only the complete token would make the HTTPS rule bypassable.
    if (option.length > 2 && BUNDLE_URI.startsWith(option)) {
      refuse(`argument ${argument} is not an accepted bundle URI spelling`)
    }
    if (argument.startsWith(BUNDLE_URI)) refuse(`argument ${argument} is not an accepted bundle URI spelling`)
  }
  if (seen && subcommand !== 'clone') refuse(`${BUNDLE_URI} is only permitted for git clone`)
  if (seen && rest.filter((argument) => argument === BUNDLE_URI || argument.startsWith(`${BUNDLE_URI}=`)).length > 1) {
    refuse(`${BUNDLE_URI} may be supplied once`)
  }
}

/** Resolve a possibly-not-yet-existing path without following a symlink out of the staging root. */
function canonicalPotential(path: string): string {
  const absolute = normalize(resolve(path))
  const missing: string[] = []
  let current = absolute
  while (true) {
    try {
      lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') refuse(`cannot inspect bundle path: ${path}`)
      const parent = dirname(current)
      if (parent === current) refuse(`cannot resolve bundle path: ${path}`)
      missing.unshift(basename(current))
      current = parent
      continue
    }
    try {
      const existing = realpathSync(current)
      return missing.length === 0 ? existing : join(existing, ...missing)
    } catch {
      refuse(`bundle path contains a broken symlink: ${path}`)
    }
  }
}

function canonicalStagingRoot(stagingRoot: string): string {
  const absolute = normalize(resolve(stagingRoot))
  let stat
  try {
    stat = lstatSync(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') refuse('bundle staging root does not exist')
    refuse(`cannot inspect bundle staging root: ${stagingRoot}`)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuse('bundle staging root must be a real directory')
  try {
    return realpathSync(absolute)
  } catch {
    refuse(`cannot resolve bundle staging root: ${stagingRoot}`)
  }
}

function validateBundleFile(stagingRoot: string | undefined, file: string): void {
  if (!stagingRoot) refuse('bundle create requires a staging root')
  if (!isAbsolute(file)) refuse('bundle output file must be absolute')
  if (CONTROL_CHARACTER.test(file)) refuse('bundle output file contains a control character')
  if (basename(file).length <= '.bundle'.length || !basename(file).endsWith('.bundle')) {
    refuse('bundle output file must end in .bundle')
  }
  try {
    lstatSync(file)
    refuse('bundle output file already exists')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const root = canonicalStagingRoot(stagingRoot)
  const target = canonicalPotential(file)
  if (target === root || !target.startsWith(root + sep)) refuse(`bundle output escapes the staging root: ${file}`)
  const relative = target.slice(root.length + sep.length)
  if (relative.split(sep).some((part) => !SAFE_BUNDLE_PATH_SEGMENT.test(part))) {
    refuse('bundle output path contains an unsafe segment')
  }
}

function validateBundleRef(ref: string): void {
  if (ref.length === 0 || ref.length > MAX_REF_LENGTH || CONTROL_CHARACTER.test(ref) || /\s/.test(ref)) {
    refuse('bundle ref must be a bounded full ref name')
  }
  if (ref.includes('..') || ref.includes('@{')) refuse('bundle ref contains an unsafe sequence')
  const parts = ref.split('/')
  if (parts.length < 3 || parts[0] !== 'refs' || !['heads', 'tags'].includes(parts[1] ?? '')) {
    refuse('bundle ref must name refs/heads/* or refs/tags/*')
  }
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === '.' ||
        part === '..' ||
        part.startsWith('.') ||
        part.endsWith('.') ||
        part.endsWith('.lock') ||
        !SAFE_REF_COMPONENT.test(part)
    )
  ) {
    refuse('bundle ref contains an unsafe segment')
  }
}

function validateBundleCreate(subcommand: string, rest: string[], options: GitCommandPolicyOptions | undefined): void {
  if (subcommand !== 'bundle') return
  if (rest.length !== 3 && rest.length !== 4)
    refuse('git bundle is admitted only as bundle create <file> [--filter=blob:none] <ref>')
  if (rest[0] !== 'create') refuse('git bundle is admitted only for create')
  const file = rest[1]
  const maybeFilter = rest.length === 4 ? rest[2] : undefined
  const ref = rest.at(-1)
  if (!file || !ref) refuse('git bundle create requires a file and ref')
  if (maybeFilter !== undefined && maybeFilter !== BUNDLE_FILTER)
    refuse('git bundle create accepts only --filter=blob:none')
  validateBundleFile(options?.stagingRoot, file)
  validateBundleRef(ref)
}

export function validateGitArgs(args: string[], options?: GitCommandPolicyOptions): void {
  const [subcommand, ...rest] = args
  if (!subcommand || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    throw new ExecRefusedError(`git ${subcommand ?? '(none)'} is not in the permitted inventory`)
  }
  const perSubcommand = REFUSED_SUBCOMMAND_ARGUMENT[subcommand] ?? []
  for (const argument of args) {
    if (isRefusedArgument(argument)) {
      throw new ExecRefusedError(`argument ${argument} is refused`)
    }
  }
  for (const argument of rest) {
    if (perSubcommand.some((pattern) => pattern.test(argument))) {
      throw new ExecRefusedError(`argument ${argument} is refused for git ${subcommand}`)
    }
  }
  validateBundleUris(args)
  validateBundleCreate(subcommand, rest, options)
}
