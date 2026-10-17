import { execFile } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  LINK_FILE,
  findLink,
  getGitRemote,
  getRepoRoot,
  normalizeRemoteUrl,
} from '@agentcairn/core'
import type { ProjectHint } from './client.js'

const execFileAsync = promisify(execFile)

export interface LocalProject {
  /** Repo root, or the working folder outside a repo. */
  dir: string
  /** From `.cairn.json`. */
  projectId: string | undefined
  /** Normalized git remote (no credentials), safe to share. */
  remote: string | undefined
}

/** What this folder says about itself: its link file and its git remote. */
export async function readLocalProject(cwd: string): Promise<LocalProject> {
  const dir = (await getRepoRoot(cwd)) ?? resolve(cwd)
  const link = await findLink(dir)
  const raw = await getGitRemote(dir)
  return { dir, projectId: link?.projectId, remote: (raw && normalizeRemoteUrl(raw)) || undefined }
}

export const hintOf = (p: LocalProject): ProjectHint => ({ projectId: p.projectId, remote: p.remote })

/** Keeps `.cairn.json` out of git without touching the shared .gitignore. */
export async function excludeLinkFile(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: dir })
    const file = resolve(dir, stdout.trim())
    const current = await readFile(file, 'utf8').catch(() => '')
    if (current.split(/\r?\n/).includes(LINK_FILE)) return true
    await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}${LINK_FILE}\n`)
    return true
  } catch {
    return false
  }
}
