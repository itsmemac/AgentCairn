import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RepoState {
  /** Full SHA of HEAD, or null outside a repo or before the first commit. */
  head: string | null
  /** `git config user.name`, used as the author of memories. */
  user: string | null
}

async function gitRaw(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 })
    return stdout
  } catch {
    return null
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  return (await gitRaw(cwd, args))?.trim() || null
}

/** Top-level folder of the git repo containing `cwd`, or null outside a repo. */
export async function getRepoRoot(cwd: string): Promise<string | null> {
  return git(cwd, ['rev-parse', '--show-toplevel'])
}

export async function getRepoState(cwd: string): Promise<RepoState> {
  const [head, user] = await Promise.all([git(cwd, ['rev-parse', 'HEAD']), git(cwd, ['config', 'user.name'])])
  return { head, user }
}

export interface Workspace {
  branch: string | null
  head: string | null
  headSubject: string | null
  /** Files with uncommitted changes (modified, added, deleted or untracked). */
  dirty: string[]
  /** Commits since `since`, newest first, as `abc1234 subject`. */
  commits: string[]
  user: string | null
}

/**
 * Where a working tree stands: branch, HEAD, uncommitted files, and what was committed since a time.
 * Recorded with sessions and handoffs, so the next person can tell what is, and is not, in the repository.
 */
export async function getWorkspace(cwd: string, options: { since?: string } = {}): Promise<Workspace> {
  const [branch, head, headSubject, status, log, user] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['log', '-1', '--pretty=%s']),
    gitRaw(cwd, ['status', '--porcelain', '--untracked-files=normal']),
    options.since ? git(cwd, ['log', `--since=${options.since}`, '--pretty=%h %s', '-n', '25']) : Promise.resolve(null),
    git(cwd, ['config', 'user.name']),
  ])
  const dirty = (status ?? '')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => line.slice(3).trim().replace(/^"|"$/g, ''))
    .map(path => (path.includes(' -> ') ? path.split(' -> ').pop()! : path))
    .filter(Boolean)
  return { branch: branch === 'HEAD' ? null : branch, head, headSubject, dirty, commits: (log ?? '').split('\n').filter(Boolean), user }
}

/** Whether a commit exists in this clone. False means it was never fetched, or never pushed from where it was made. */
export async function hasCommit(cwd: string, sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false
  return (await git(cwd, ['cat-file', '-t', sha])) === 'commit'
}

/** Which of `paths` changed between `base` and HEAD (empty when base is unknown here, or nothing changed). */
export async function changedSince(cwd: string, base: string, paths: readonly string[]): Promise<string[]> {
  if (!/^[0-9a-f]{7,40}$/i.test(base) || paths.length === 0) return []
  const out = await git(cwd, ['diff', '--name-only', `${base}..HEAD`, '--', ...paths.slice(0, 50)])
  return (out ?? '').split('\n').filter(Boolean)
}

/** How many commits `head` is ahead of `base` (null when either is unknown here). */
export async function commitsBetween(cwd: string, base: string, head = 'HEAD'): Promise<number | null> {
  if (!/^[0-9a-f]{7,40}$/i.test(base)) return null
  const n = await git(cwd, ['rev-list', '--count', `${base}..${head}`])
  return n === null ? null : Number(n)
}
