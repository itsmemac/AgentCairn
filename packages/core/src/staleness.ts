import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Memory } from './memory.js'

const execFileAsync = promisify(execFile)

export type StalenessStatus = 'fresh' | 'stale' | 'unchecked'

export interface Staleness {
  status: StalenessStatus
  /** Paths the memory names that changed since it was written. */
  changedPaths: string[]
}

type Checkable = Pick<Memory, 'id' | 'commitSha' | 'paths'>

const SHA = /^[0-9a-f]{7,40}$/i
const UNCHECKED: Staleness = { status: 'unchecked', changedPaths: [] }

const cleanPath = (p: string) => p.trim().replace(/^\.\//, '').replace(/\/+$/, '')

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
    return stdout
  } catch {
    return null
  }
}

/**
 * Compares each memory's recorded commit with the working tree of the repo at
 * `cwd`. A memory is `stale` when a path it names changed since (committed or
 * not, deletions and renames included), `fresh` when none did, and `unchecked`
 * when there is nothing to compare: no paths, no commit, a commit this clone
 * does not have, or no git repo.
 */
export async function checkStaleness(
  cwd: string,
  memories: readonly Checkable[],
): Promise<Map<string, Staleness>> {
  const result = new Map<string, Staleness>()
  const bySha = new Map<string, Checkable[]>()

  for (const m of memories) {
    const paths = m.paths.map(cleanPath).filter(Boolean)
    if (!m.commitSha || !SHA.test(m.commitSha) || paths.length === 0) {
      result.set(m.id, UNCHECKED)
      continue
    }
    const group = bySha.get(m.commitSha) ?? []
    group.push(m)
    bySha.set(m.commitSha, group)
  }

  for (const [sha, group] of bySha) {
    const known = await git(cwd, ['cat-file', '-e', `${sha}^{commit}`])
    if (known === null) {
      for (const m of group) result.set(m.id, UNCHECKED)
      continue
    }

    const union = [...new Set(group.flatMap(m => m.paths.map(cleanPath).filter(Boolean)))]
    const diff = await git(cwd, [
      'diff',
      '--name-only',
      '--no-renames',
      sha,
      '--',
      ...union.map(p => `:(literal)${p}`),
    ])
    if (diff === null) {
      for (const m of group) result.set(m.id, UNCHECKED)
      continue
    }

    const changed = diff.split(/\r?\n/).filter(Boolean)
    for (const m of group) {
      const own = m.paths.map(cleanPath).filter(Boolean)
      const hits = changed.filter(file => own.some(p => file === p || file.startsWith(`${p}/`)))
      result.set(m.id, hits.length ? { status: 'stale', changedPaths: hits } : { status: 'fresh', changedPaths: [] })
    }
  }

  return result
}
