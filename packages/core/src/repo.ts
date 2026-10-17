import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RepoState {
  /** Full SHA of HEAD, or null outside a repo or before the first commit. */
  head: string | null
  /** `git config user.name`, used as the author of memories. */
  user: string | null
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** Top-level folder of the git repo containing `cwd`, or null outside a repo. */
export async function getRepoRoot(cwd: string): Promise<string | null> {
  return git(cwd, ['rev-parse', '--show-toplevel'])
}

export async function getRepoState(cwd: string): Promise<RepoState> {
  const [head, user] = await Promise.all([git(cwd, ['rev-parse', 'HEAD']), git(cwd, ['config', 'user.name'])])
  return { head, user }
}
