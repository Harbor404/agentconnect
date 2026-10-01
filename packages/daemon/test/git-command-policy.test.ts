import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateGitArgs } from '../src/workspace/git-command-policy.js'

const roots: string[] = []

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; stagingRoot: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ac-git-policy-')))
  roots.push(root)
  const stagingRoot = join(root, 'staging')
  mkdirSync(stagingRoot)
  return { root, stagingRoot }
}

function allowed(args: string[], stagingRoot: string): void {
  expect(() => validateGitArgs(args, { stagingRoot })).not.toThrow()
}

function refused(args: string[], stagingRoot: string): void {
  expect(() => validateGitArgs(args, { stagingRoot }), JSON.stringify(args)).toThrow()
}

describe('Git command policy', () => {
  it('accepts both Git spellings of an HTTPS bundle URI', () => {
    const { stagingRoot } = fixture()
    for (const args of [
      [
        'clone',
        '--bundle-uri=https://cache.example.test/repo.bundle?X-Amz-Signature=a%2Fb',
        'https://github.com/acme/repo.git',
        'repo'
      ],
      [
        'clone',
        '--bundle-uri',
        'https://cache.example.test/repo.bundle?X-Amz-Signature=a%2Fb',
        'https://github.com/acme/repo.git',
        'repo'
      ]
    ]) {
      allowed(args, stagingRoot)
    }
  })

  it('refuses every non-HTTPS or ambiguous bundle URI spelling', () => {
    const { stagingRoot } = fixture()
    const remote = 'https://github.com/acme/repo.git'
    const refusedArgs = [
      ['clone', '--bundle-uri=http://cache.example.test/repo.bundle', remote, 'repo'],
      ['clone', '--bundle-uri=ssh://git@example.test/repo.bundle', remote, 'repo'],
      ['clone', '--bundle-uri=file:///etc/passwd', remote, 'repo'],
      ['clone', '--bundle-uri=/tmp/repo.bundle', remote, 'repo'],
      ['clone', '--bundle-uri=https:/cache.example.test/repo.bundle', remote, 'repo'],
      ['clone', '--bundle-uri=https://', remote, 'repo'],
      ['clone', '--bundle-uri=HTTPS://cache.example.test/repo.bundle', remote, 'repo'],
      ['clone', '--bundle-uri=https://user:pass@cache.example.test/repo.bundle', remote, 'repo'],
      ['clone', '--bundle-uri=https://cache.example.test/repo.bundle\n--upload-pack=evil', remote, 'repo'],
      ['clone', '--bundle-uri', 'file:///tmp/repo.bundle', remote, 'repo'],
      ['clone', '--bundle-uri', '--filter=blob:none', remote, 'repo'],
      ['clone', '--bundle-uri', 'ssh://git@example.test/repo', remote, 'repo'],
      ['clone', '--bundle-urihttps://cache.example.test/repo.bundle', remote, 'repo'],
      ['clone', '--bu=file:///etc/passwd', remote, 'repo'],
      ['clone', '--bundle-u', 'file:///etc/passwd', remote, 'repo'],
      [
        'clone',
        '--bundle-uri=https://cache.example.test/one.bundle',
        '--bundle-uri=https://cache.example.test/two.bundle',
        remote,
        'repo'
      ],
      ['fetch', '--bundle-uri=https://cache.example.test/repo.bundle', 'origin']
    ]
    for (const args of refusedArgs) refused(args, stagingRoot)
  })

  it('accepts only the bundle create grammar and the exact blobless filter spelling', () => {
    const { stagingRoot } = fixture()
    mkdirSync(join(stagingRoot, 'nested'))
    allowed(['bundle', 'create', join(stagingRoot, 'full.bundle'), 'refs/heads/main'], stagingRoot)
    allowed(
      ['bundle', 'create', join(stagingRoot, 'nested', 'blobless.bundle'), '--filter=blob:none', 'refs/tags/v1.2.3'],
      stagingRoot
    )
  })

  it('refuses every other bundle verb and extra bundle-create spelling', () => {
    const { stagingRoot } = fixture()
    const file = join(stagingRoot, 'repo.bundle')
    const refusedArgs = [
      ['bundle'],
      ['bundle', 'verify', file],
      ['bundle', 'list-heads', file],
      ['bundle', 'unbundle', file],
      ['unbundle', file],
      ['verify', file],
      ['list-heads', file],
      ['bundle', 'create', file, '--all'],
      ['bundle', 'create', file, 'refs/heads/main', '--filter=blob:none'],
      ['bundle', 'create', '--filter=blob:none', file, 'refs/heads/main'],
      ['bundle', 'create', file, '--filter', 'blob:none', 'refs/heads/main'],
      ['bundle', 'create', file, '--filter=blob:limit=10', 'refs/heads/main'],
      ['bundle', 'create', file, '--filter=blob:none', '--all'],
      ['bundle', 'create', file, '--filter=blob:none', 'refs/heads/main', 'extra'],
      ['bundle', 'create', file, '--quiet', 'refs/heads/main'],
      ['bundle', 'create', file, 'refs/heads/main', '--version=3']
    ]
    for (const args of refusedArgs) refused(args, stagingRoot)
  })

  it('refuses bundle output paths outside the staging root, including symlink escapes', () => {
    const { root, stagingRoot } = fixture()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const outsideFile = join(outside, 'escape.bundle')
    writeFileSync(outsideFile, 'outside')

    for (const file of [
      outsideFile,
      join(stagingRoot, '..', 'escape.bundle'),
      'relative.bundle',
      join(stagingRoot, 'not-a-bundle.txt')
    ]) {
      refused(['bundle', 'create', file, 'refs/heads/main'], stagingRoot)
    }

    symlinkSync(outside, join(stagingRoot, 'linked-outside'))
    refused(['bundle', 'create', join(stagingRoot, 'linked-outside', 'escape.bundle'), 'refs/heads/main'], stagingRoot)
    symlinkSync(outsideFile, join(stagingRoot, 'linked-file.bundle'))
    refused(['bundle', 'create', join(stagingRoot, 'linked-file.bundle'), 'refs/heads/main'], stagingRoot)

    renameSync(stagingRoot, join(root, 'staging-real'))
    symlinkSync(outside, stagingRoot)
    refused(['bundle', 'create', join(stagingRoot, 'root-replacement.bundle'), 'refs/heads/main'], stagingRoot)
  })

  it('refuses refs that read as options, revisions, or injected commands', () => {
    const { stagingRoot } = fixture()
    const file = join(stagingRoot, 'repo.bundle')
    for (const ref of [
      '--all',
      'HEAD',
      'main',
      'refs/heads/main;touch /tmp/pwned',
      'refs/heads/main$(touch /tmp/pwned)',
      'refs/heads/`touch /tmp/pwned`',
      'refs/heads/main\n--all',
      'refs/heads/main..next',
      'refs/heads/main.lock',
      'refs/heads/.hidden',
      'refs/heads/',
      'refs/remotes/origin/main'
    ]) {
      refused(['bundle', 'create', file, ref], stagingRoot)
    }
  })
})
