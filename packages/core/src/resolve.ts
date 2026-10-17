import type { Brain } from './db.js'
import {
  findLink,
  getGitRemote,
  isValidProjectId,
  normalizeRemoteHint,
  normalizeRemoteUrl,
  remoteHash,
  writeLink,
} from './identity.js'
import { attachRemote, ensureProject, findProjectByRemote, projectExists } from './registry.js'

export type ResolutionSource = 'link' | 'remote'

export interface ResolvedProject {
  projectId: string
  source: ResolutionSource
  /** Hash of the git remote, when the folder has a usable one. */
  remoteHash: string | null
  /** True when the project is not in the brain yet. */
  isNew: boolean
}

export class UnresolvedProjectError extends Error {
  /**
   * `folder`: a local check of a working directory found no link file and no git remote.
   * `request`: a remote client sent no project at all; the server cannot see its folder, so
   * the fix is on the client side (a project header), not "no git remote".
   */
  constructor(reason: 'folder' | 'request' = 'folder') {
    super(
      reason === 'request'
        ? 'This request does not say which project it is for. Send an X-Cairn-Project header (the Access page in the dashboard generates the command), or run `cairn init <projectId>` in the project folder.'
        : 'Cannot identify this project: no .cairn.json and no git remote. Run `cairn init <projectId>`.',
    )
    this.name = 'UnresolvedProjectError'
  }
}

export class ProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`Project "${projectId}" does not exist yet.`)
    this.name = 'ProjectNotFoundError'
  }
}

async function currentRemoteHash(cwd: string): Promise<string | null> {
  const raw = await getGitRemote(cwd)
  const normalized = raw ? normalizeRemoteUrl(raw) : null
  return normalized ? remoteHash(normalized) : null
}

/** Project for a remote hash: an alias registered with a project, else a fresh `git-<hash>` id. */
async function projectForRemote(brain: Brain, hash: string): Promise<ResolvedProject> {
  const owner = await findProjectByRemote(brain, hash)
  return owner
    ? { projectId: owner, source: 'remote', remoteHash: hash, isNew: false }
    : { projectId: `git-${hash}`, source: 'remote', remoteHash: hash, isNew: true }
}

/**
 * Order: `.cairn.json` link, then the git remote (an alias registered with
 * a project, else a fresh `git-<hash>` id). Read-only: never writes.
 */
export async function resolveProject(brain: Brain, cwd: string): Promise<ResolvedProject> {
  const hash = await currentRemoteHash(cwd)

  const link = await findLink(cwd)
  if (link) {
    return {
      projectId: link.projectId,
      source: 'link',
      remoteHash: hash,
      isNew: !(await projectExists(brain, link.projectId)),
    }
  }

  if (!hash) throw new UnresolvedProjectError()
  return projectForRemote(brain, hash)
}

/** What a client that cannot be inspected (a remote server cannot read your repo) says about itself. */
export interface ProjectHint {
  projectId?: string
  /** A git remote, raw or already normalized (`host/owner/repo`). Credentials are dropped. */
  remote?: string
}

/** Same rules as `resolveProject`, but from what the client sent instead of from a folder. Read-only. */
export async function resolveProjectFromHint(brain: Brain, hint: ProjectHint): Promise<ResolvedProject> {
  const normalized = hint.remote ? normalizeRemoteHint(hint.remote) : null
  const hash = normalized ? remoteHash(normalized) : null

  if (hint.projectId) {
    if (!isValidProjectId(hint.projectId)) throw new Error(`Invalid project id "${hint.projectId}".`)
    return {
      projectId: hint.projectId,
      source: 'link',
      remoteHash: hash,
      isNew: !(await projectExists(brain, hint.projectId)),
    }
  }
  if (!hash) throw new UnresolvedProjectError('request')
  return projectForRemote(brain, hash)
}

export interface RegisterOptions {
  /** Allow creating the project when the id does not exist yet. */
  allowCreate?: boolean
  /** Move the git remote from another project to this one. */
  forceRemote?: boolean
}

export interface RegisterResult {
  projectId: string
  created: boolean
  remoteAttached: boolean
}

/**
 * Database side of `cairn init`: makes sure the project exists and attaches
 * the git remote as an alias, so other clones with the same remote resolve to
 * the same project. Writes no files.
 */
export async function registerProject(
  brain: Brain,
  input: { projectId?: string; remoteHash?: string | null },
  options: RegisterOptions = {},
): Promise<RegisterResult> {
  const hash = input.remoteHash ?? null

  let id = input.projectId
  if (id === undefined) {
    if (!hash) throw new UnresolvedProjectError()
    id = (await findProjectByRemote(brain, hash)) ?? `git-${hash}`
  } else if (!isValidProjectId(id)) {
    throw new Error(`Invalid project id "${id}": use letters, digits, ".", "_" or "-" (max 64).`)
  }

  if (input.projectId !== undefined && !options.allowCreate && !(await projectExists(brain, id))) {
    throw new ProjectNotFoundError(id)
  }

  const { created } = await ensureProject(brain, id)
  if (hash) await attachRemote(brain, id, hash, { force: options.forceRemote })
  return { projectId: id, created, remoteAttached: hash !== null }
}

export type InitOptions = RegisterOptions
export type InitResult = RegisterResult

/**
 * `cairn init [projectId]` for a folder that can reach the database
 * directly: registers the project and writes `.cairn.json`.
 */
export async function initProject(
  brain: Brain,
  dir: string,
  projectId?: string,
  options: InitOptions = {},
): Promise<InitResult> {
  const result = await registerProject(brain, { projectId, remoteHash: await currentRemoteHash(dir) }, options)
  await writeLink(dir, result.projectId)
  return result
}
