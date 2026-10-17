import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findLink,
  getGitRemote,
  isValidProjectId,
  normalizeRemoteUrl,
  remoteHash,
  writeLink,
} from '../src/identity.js'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cairn-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('normalizeRemoteUrl', () => {
  const same = [
    'git@github.com:Acme/Widget.git',
    'https://github.com/acme/widget',
    'https://github.com/acme/widget.git',
    'https://github.com/acme/widget/',
    'https://user:token@GitHub.com/Acme/Widget.git',
    'ssh://git@github.com:22/acme/widget.git',
    'ssh://git@github.com/acme/widget',
    'git://github.com/acme/widget.git',
  ]
  it.each(same)('maps %s to github.com/acme/widget', raw => {
    expect(normalizeRemoteUrl(raw)).toBe('github.com/acme/widget')
  })

  it('keeps nested paths (GitLab subgroups)', () => {
    expect(normalizeRemoteUrl('git@gitlab.com:group/sub/repo.git')).toBe('gitlab.com/group/sub/repo')
  })

  it.each(['', '   ', '/srv/git/repo.git', 'C:\\repos\\widget', 'file:///srv/git/repo.git', '../relative'])(
    'returns null for %j',
    raw => {
      expect(normalizeRemoteUrl(raw)).toBeNull()
    },
  )

  it('hashes equal remotes equally and never leaks the url', () => {
    const a = remoteHash(normalizeRemoteUrl('git@github.com:acme/widget.git')!)
    const b = remoteHash(normalizeRemoteUrl('https://github.com/acme/widget')!)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('isValidProjectId', () => {
  it.each(['my-project', 'a', 'Proj_1.2', 'x'.repeat(64)])('accepts %s', id => {
    expect(isValidProjectId(id)).toBe(true)
  })
  it.each(['', '-lead', 'has space', 'a/b', 'x'.repeat(65), '../etc'])('rejects %j', id => {
    expect(isValidProjectId(id)).toBe(false)
  })
})

describe('link file', () => {
  it('round-trips and is found from a nested folder', async () => {
    const root = tmp()
    await writeLink(root, 'my-project')
    const nested = join(root, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    expect(await findLink(nested)).toEqual({ projectId: 'my-project', dir: root })
  })

  it('returns null when absent', async () => {
    expect(await findLink(tmp())).toBeNull()
  })

  it('refuses to write an invalid id', async () => {
    await expect(writeLink(tmp(), 'bad id')).rejects.toThrow(/Invalid project id/)
  })
})

describe('getGitRemote', () => {
  it('reads origin, and null without a repo or remote', async () => {
    const repo = tmp()
    execFileSync('git', ['init', '-q'], { cwd: repo })
    expect(await getGitRemote(repo)).toBeNull()
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widget.git'], { cwd: repo })
    expect(await getGitRemote(repo)).toBe('git@github.com:acme/widget.git')
  })
})
