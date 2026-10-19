import {
  type Principal,
  type ProjectRef,
  AccessError,
  ProjectNameError,
  SOLO_PRINCIPAL,
  authorize,
  createProject,
  findAccessibleProject,
  nameFromRemote,
  normalizeProjectName,
} from './access.js'
import type { Brain } from './db.js'
import {
  findLink,
  getGitRemote,
  normalizeRemoteHint,
  normalizeRemoteUrl,
  remoteHash,
  writeLink,
} from './identity.js'
import { attachRemote, ensureProject, findProjectByRemote } from './registry.js'

export type ResolutionSource = 'link' | 'remote'

/**
 * What `projectId` holds for a project that does not exist, or that the caller may not see. It can never
 * equal a real id (ids have no colon), so using it to read data finds nothing, and nobody learns
 * whether someone else's project exists.
 */
export const PENDING = 'pending:'

export interface ResolvedProject {
  /** The project's id, or a `pending:` placeholder when `isNew`. */
  projectId: string
  /** What the caller asked for (an id or a name), when it matched nothing they can see. */
  requested?: string
  source: ResolutionSource
  /** Hash of the git remote, when the folder has a usable one. */
  remoteHash: string | null
  /** True when the project is not in the brain yet (or not visible to the caller). */
  isNew: boolean
  /** For a project known only by its git remote: what to call it when it is created. */
  suggestedName?: string
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

async function currentRemote(cwd: string): Promise<string | null> {
  const raw = await getGitRemote(cwd)
  return raw ? normalizeRemoteUrl(raw) : null
}

/** Project for a remote hash among those the principal can access, else a placeholder id for one to be created. */
async function projectForRemote(brain: Brain, hash: string, normalized: string, principal: Principal): Promise<ResolvedProject> {
  const owner = await findProjectByRemote(brain, hash, principal)
  return owner
    ? { projectId: owner, source: 'remote', remoteHash: hash, isNew: false }
    : { projectId: `${PENDING}${hash}`, source: 'remote', remoteHash: hash, isNew: true, suggestedName: nameFromRemote(normalized) }
}

/**
 * Order: `.cairn.json` link (an id, or a name), then the git remote. Read-only: never writes.
 * This is the local form, for a server that can see the folder (stdio mode): one user, no access checks.
 */
export async function resolveProject(brain: Brain, cwd: string): Promise<ResolvedProject> {
  const normalized = await currentRemote(cwd)
  const hash = normalized ? remoteHash(normalized) : null

  const link = await findLink(cwd)
  if (link) {
    const found = await findAccessibleProject(brain, SOLO_PRINCIPAL, link.projectId)
    return found
      ? { projectId: found.id, source: 'link', remoteHash: hash, isNew: false }
      : { projectId: `${PENDING}${link.projectId}`, requested: link.projectId, source: 'link', remoteHash: hash, isNew: true }
  }

  if (!hash || !normalized) throw new UnresolvedProjectError()
  return projectForRemote(brain, hash, normalized, SOLO_PRINCIPAL)
}

/** What a client that cannot be inspected (a remote server cannot read your repo) says about itself. */
export interface ProjectHint {
  /** A project id, or a project name. */
  projectId?: string
  /** A git remote, raw or already normalized (`host/owner/repo`). Credentials are dropped. */
  remote?: string
}

/**
 * Same rules as `resolveProject`, but from what the client sent instead of from a folder, and only
 * among the projects the principal can see. A project they cannot see looks exactly like one that does
 * not exist. Read-only.
 */
export async function resolveProjectFromHint(brain: Brain, hint: ProjectHint, principal: Principal = SOLO_PRINCIPAL): Promise<ResolvedProject> {
  const normalized = hint.remote ? normalizeRemoteHint(hint.remote) : null
  const hash = normalized ? remoteHash(normalized) : null

  if (hint.projectId) {
    const key = normalizeProjectName(hint.projectId)
    const found = await findAccessibleProject(brain, principal, key)
    return found
      ? { projectId: found.id, source: 'link', remoteHash: hash, isNew: false }
      : { projectId: `${PENDING}${key}`, requested: key, source: 'link', remoteHash: hash, isNew: true }
  }
  if (!hash || !normalized) throw new UnresolvedProjectError('request')
  return projectForRemote(brain, hash, normalized, principal)
}

export interface RegisterOptions {
  /** Allow creating the project when it does not exist yet. */
  allowCreate?: boolean
  /** Move the git remote from another project of yours to this one. */
  forceRemote?: boolean
}

export interface RegisterResult {
  projectId: string
  name: string
  created: boolean
  remoteAttached: boolean
}

/** A new project for this person. Before any account exists there is nobody to own it, so it is the plain legacy form. */
async function createFor(brain: Brain, principal: Principal, name: string): Promise<ProjectRef> {
  if (principal.userId === SOLO_PRINCIPAL.userId) {
    const clean = normalizeProjectName(name)
    await ensureProject(brain, clean)
    return { id: clean, name: clean }
  }
  return createProject(brain, principal.userId, name)
}

/**
 * Database side of `cairn init`: finds the project (by id, then by name, among those the caller can
 * see), or creates it when allowed, and attaches the git remote as an alias so other clones resolve to
 * the same project. Writes no files. With no id it uses the git remote, and a new project is named
 * after the repository.
 */
export async function registerProject(
  brain: Brain,
  input: { projectId?: string; remoteHash?: string | null; remote?: string | null },
  options: RegisterOptions = {},
  principal: Principal = SOLO_PRINCIPAL,
): Promise<RegisterResult> {
  const hash = input.remoteHash ?? null

  let ref: ProjectRef | null
  let created = false
  if (input.projectId !== undefined) {
    const key = normalizeProjectName(input.projectId)
    ref = await findAccessibleProject(brain, principal, key)
    if (!ref) {
      if (!options.allowCreate) throw new ProjectNotFoundError(key)
      ref = await createFor(brain, principal, key)
      created = true
    }
  } else {
    if (!hash) throw new UnresolvedProjectError()
    const existing = await findProjectByRemote(brain, hash, principal)
    if (existing) {
      const found = await findAccessibleProject(brain, principal, existing)
      ref = found ?? { id: existing, name: existing }
    } else {
      const base = nameFromRemote(input.remote ?? hash)
      ref = null
      for (let n = 1; !ref; n++) {
        try {
          ref = await createFor(brain, principal, n === 1 ? base : `${base} (${n})`)
        } catch (error) {
          if (!(error instanceof ProjectNameError && error.code === 'exists') || n >= 20) throw error
        }
      }
      created = true
    }
  }

  let remoteAttached = false
  if (hash) {
    // linking a folder needs no rights on the project, but registering an alias for everyone needs maintainer
    const allowed = await authorize(brain, principal, 'project.update', ref.id).then(
      () => true,
      error => {
        if (error instanceof AccessError) return false
        throw error
      },
    )
    if (allowed) {
      await attachRemote(brain, ref.id, hash, { force: options.forceRemote, principal })
      remoteAttached = true
    }
  }
  return { projectId: ref.id, name: ref.name, created, remoteAttached }
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
  const normalized = await currentRemote(dir)
  const result = await registerProject(
    brain,
    { projectId, remoteHash: normalized ? remoteHash(normalized) : null, remote: normalized },
    options,
  )
  await writeLink(dir, result.projectId)
  return result
}

