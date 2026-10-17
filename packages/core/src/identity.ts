import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const LINK_FILE = '.cairn.json'
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export function isValidProjectId(id: string): boolean {
  return PROJECT_ID_PATTERN.test(id)
}

/**
 * Reduces any spelling of a git remote to `host/owner/repo` (lowercase, no
 * credentials, port, `.git` or trailing slash) so every clone of one repo
 * matches. Returns null for empty input and for local paths, which differ
 * per machine and cannot identify a project.
 */
export function normalizeRemoteUrl(raw: string): string | null {
  let url = raw.trim()
  if (!url) return null

  const hasScheme = /^[a-z][a-z0-9+.-]{1,}:\/\//i.test(url)
  if (!hasScheme) {
    // scp-like syntax: [user@]host:path (a drive letter like C:\ is a local path)
    const scp = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(.+)$/.exec(url)
    if (!scp) return null
    url = `ssh://${scp[1]}/${scp[2]}`
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol === 'file:' || !parsed.hostname) return null

  const path = parsed.pathname
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+/, '')
  if (!path) return null

  return `${parsed.hostname}/${path}`.toLowerCase()
}

/**
 * Accepts what a client sends as its remote: any git URL, or an already
 * normalized `host/owner/repo` (what `cairn init` puts in shared config so no
 * credentials are ever committed).
 */
export function normalizeRemoteHint(raw: string): string | null {
  const viaUrl = normalizeRemoteUrl(raw)
  if (viaUrl) return viaUrl
  const bare = raw.trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase()
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?\/[^\s/]+(\/[^\s/]+)*$/.test(bare) && !bare.includes('@') ? bare : null
}

/** Stable, URL-free key for a normalized remote (safe to store in a shared DB). */
export function remoteHash(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

export interface LinkFile {
  projectId: string
}

export interface FoundLink extends LinkFile {
  dir: string
}

/** Walks up from `start` looking for `.cairn.json`. */
export async function findLink(start: string): Promise<FoundLink | null> {
  let dir = resolve(start)
  for (;;) {
    try {
      const data = JSON.parse(await readFile(join(dir, LINK_FILE), 'utf8')) as Partial<LinkFile>
      if (typeof data.projectId === 'string' && isValidProjectId(data.projectId)) {
        return { projectId: data.projectId, dir }
      }
    } catch {
      // missing or unreadable: keep walking
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export async function writeLink(dir: string, projectId: string): Promise<void> {
  if (!isValidProjectId(projectId)) {
    throw new Error(`Invalid project id "${projectId}": use letters, digits, ".", "_" or "-" (max 64).`)
  }
  await writeFile(join(dir, LINK_FILE), `${JSON.stringify({ projectId }, null, 2)}\n`)
}

/** The `origin` remote (else the first remote) of the repo at `cwd`, raw as git prints it. */
export async function getGitRemote(cwd: string): Promise<string | null> {
  const git = async (...args: string[]) => {
    try {
      const { stdout } = await execFileAsync('git', args, { cwd })
      return stdout.trim()
    } catch {
      return null
    }
  }
  const origin = await git('remote', 'get-url', 'origin')
  if (origin) return origin
  const first = (await git('remote'))?.split(/\r?\n/)[0]
  return first ? await git('remote', 'get-url', first) : null
}
