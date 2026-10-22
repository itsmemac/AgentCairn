import { randomBytes } from 'node:crypto'
import type { Brain } from './db.js'

// ---- roles and permissions -------------------------------------------------

export const PROJECT_ROLES = ['viewer', 'editor', 'maintainer', 'owner'] as const
export type ProjectRole = (typeof PROJECT_ROLES)[number]

export const INSTANCE_ROLES = ['admin', 'member'] as const
export type InstanceRole = (typeof INSTANCE_ROLES)[number]

export const ACTIONS = ['memory.read', 'memory.write', 'memory.delete', 'project.update', 'member.manage', 'project.delete'] as const
export type Action = (typeof ACTIONS)[number]

const RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, maintainer: 3, owner: 4 }

/** The least powerful role that may do each thing. Anything not listed is not allowed. */
const MINIMUM_ROLE: Record<Action, ProjectRole> = {
  'memory.read': 'viewer',
  'memory.write': 'editor',
  'memory.delete': 'maintainer',
  'project.update': 'maintainer',
  'member.manage': 'maintainer',
  'project.delete': 'owner',
}

export const isProjectRole = (value: unknown): value is ProjectRole => PROJECT_ROLES.includes(value as ProjectRole)
export const isInstanceRole = (value: unknown): value is InstanceRole => INSTANCE_ROLES.includes(value as InstanceRole)

export const roleAllows = (role: ProjectRole, action: Action): boolean => RANK[role] >= RANK[MINIMUM_ROLE[action]]

// ---- who is asking ---------------------------------------------------------

/** What a token is limited to, on top of what its user may do. */
export interface TokenScope {
  /** May read memories, never write or delete them. */
  readOnly: boolean
  /** Only these projects (null: every project its user can reach). */
  projects: string[] | null
}

export interface Principal {
  userId: string
  username: string
  role: InstanceRole
  /** Present when the request came with a limited token. */
  scope?: TokenScope
  /** The name of the access token the request was made with, when it was a managed one. */
  tokenName?: string
  /**
   * Solo mode: there is at most one user, so everything is theirs and project access is not checked.
   * Adding a second user turns it off.
   */
  solo?: boolean
}

/** Acts before any account exists (a fresh install with the environment token, or no authentication). */
export const SOLO_PRINCIPAL: Principal = { userId: 'solo', username: 'solo', role: 'admin', solo: true }

export class AccessError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden',
    readonly projectId: string,
    readonly action: Action,
    readonly reason: 'role' | 'token' | 'scope' = 'role',
  ) {
    super(
      code === 'not_found'
        ? `Project "${projectId}" does not exist.`
        : reason === 'scope'
          ? 'This token is limited to particular projects and cannot create new ones.'
          : reason === 'token'
            ? `This token is read-only: it cannot ${action === 'memory.write' ? 'write memories' : action}.`
            : `Your role on this project does not allow ${action}.`,
    )
    this.name = 'AccessError'
  }
}

/** The caller's role on a project, or null when they are not a member. */
export async function projectRole(brain: Brain, userId: string, projectId: string): Promise<ProjectRole | null> {
  const r = await brain.run(
    'MATCH (:User {id: $userId})-[m:MEMBER_OF]->(:Project {id: $projectId}) RETURN m.role AS role',
    { userId, projectId },
  )
  const role = r.records[0]?.get('role')
  return isProjectRole(role) ? role : null
}

/**
 * The one place that decides. No membership reads as "not found", so a private project's existence
 * does not leak; a member whose role is too low gets "forbidden".
 */
export async function authorize(brain: Brain, principal: Principal, action: Action, projectId: string): Promise<ProjectRole> {
  // a token's own limits apply first, in solo mode too: they are a choice the person made
  if (principal.scope?.projects && !principal.scope.projects.includes(projectId)) throw new AccessError('not_found', projectId, action)
  if (principal.scope?.readOnly && action !== 'memory.read') throw new AccessError('forbidden', projectId, action, 'token')
  if (principal.solo) return 'owner'
  const role = await projectRole(brain, principal.userId, projectId)
  if (!role) throw new AccessError('not_found', projectId, action)
  if (!roleAllows(role, action)) throw new AccessError('forbidden', projectId, action)
  return role
}

/** Ids of the projects a principal can see at all. `null` means all of them (solo mode). */
export async function accessibleProjectIds(brain: Brain, principal: Principal): Promise<string[] | null> {
  const limited = principal.scope?.projects ?? null
  if (principal.solo) return limited
  const r = await brain.run('MATCH (:User {id: $userId})-[:MEMBER_OF]->(p:Project) RETURN p.id AS id', { userId: principal.userId })
  const ids = r.records.map(x => x.get('id') as string)
  return limited ? ids.filter(id => limited.includes(id)) : ids
}

/** The caller's role on every project they are a member of. */
export async function projectRoles(brain: Brain, principal: Principal): Promise<Map<string, ProjectRole>> {
  const roles = new Map<string, ProjectRole>()
  if (principal.solo) return roles // solo: every project is theirs, callers treat a missing entry as owner
  const r = await brain.run('MATCH (:User {id: $userId})-[m:MEMBER_OF]->(p:Project) RETURN p.id AS id, m.role AS role', { userId: principal.userId })
  for (const row of r.records) if (isProjectRole(row.get('role'))) roles.set(row.get('id') as string, row.get('role') as ProjectRole)
  return roles
}

// ---- projects: generated ids, names ---------------------------------------

export class ProjectNameError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'exists' | 'ambiguous' | 'limit',
  ) {
    super(message)
    this.name = 'ProjectNameError'
  }
}

export const generateProjectId = (): string => `prj_${randomBytes(6).toString('hex')}`

export function normalizeProjectName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ')
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > 64 || /[\u0000-\u001f<>]/.test(name)) {
    throw new ProjectNameError('Project name: 1-64 characters, no control characters or angle brackets.', 'invalid')
  }
  return name
}

export interface ProjectRef {
  id: string
  name: string
}

/** A name for a project made from a git remote: the repository's own name. */
export function nameFromRemote(normalized: string): string {
  const last = normalized.split('/').filter(Boolean).pop() ?? ''
  const name = last.replace(/\.git$/i, '')
  return name || normalized
}

/**
 * Creates a project owned by `ownerId`, with a generated, unique id. The name may repeat across
 * owners but is unique among the projects one owner owns.
 */
export async function createProject(brain: Brain, ownerId: string, rawName: string): Promise<ProjectRef> {
  const name = normalizeProjectName(rawName)
  const id = generateProjectId()
  const session = brain.session()
  try {
    return await session.executeWrite(async tx => {
      const owned = await tx.run(
        'MATCH (:User {id: $ownerId})-[:MEMBER_OF {role: "owner"}]->(p:Project {name: $name}) RETURN count(p) AS n',
        { ownerId, name },
      )
      if (Number(owned.records[0]?.get('n')) > 0) throw new ProjectNameError(`You already own a project named "${name}".`, 'exists')
      // the admin may cap how many projects someone can own
      const quota = await tx.run(
        'MATCH (u:User {id: $ownerId}) OPTIONAL MATCH (u)-[:MEMBER_OF {role: "owner"}]->(p:Project) RETURN u.maxProjects AS max, count(p) AS owned',
        { ownerId },
      )
      const max = quota.records[0]?.get('max')
      if (max !== null && max !== undefined && Number(quota.records[0]?.get('owned')) >= Number(max)) {
        throw new ProjectNameError(`You can own at most ${Number(max)} project${Number(max) === 1 ? '' : 's'} on this server.`, 'limit')
      }
      const made = await tx.run(
        `MATCH (u:User {id: $ownerId})
         CREATE (p:Project {id: $id, name: $name, createdAt: datetime()})
         CREATE (u)-[:MEMBER_OF {role: 'owner', since: datetime()}]->(p)
         RETURN p.id AS id, p.name AS name`,
        { ownerId, id, name },
      )
      const row = made.records[0]
      if (!row) throw new ProjectNameError('That user does not exist.', 'invalid')
      return { id: row.get('id') as string, name: row.get('name') as string }
    })
  } finally {
    await session.close()
  }
}

/**
 * Finds a project the principal can access by id or, failing that, by name. Several projects with
 * one name are ambiguous: the caller must use the id. Owned projects win over shared ones.
 */
export async function findAccessibleProject(brain: Brain, principal: Principal, idOrName: string): Promise<ProjectRef | null> {
  const byId = await brain.run('MATCH (p:Project {id: $key}) RETURN p.id AS id, coalesce(p.name, p.id) AS name', { key: idOrName })
  const direct = byId.records[0]
  if (direct) {
    const id = direct.get('id') as string
    if (principal.scope?.projects && !principal.scope.projects.includes(id)) return null
    if (principal.solo || (await projectRole(brain, principal.userId, id))) return { id, name: direct.get('name') as string }
    return null
  }
  const byName = await brain.run(
    principal.solo
      ? 'MATCH (p:Project) WHERE coalesce(p.name, p.id) = $key RETURN p.id AS id, p.name AS name, "owner" AS role'
      : `MATCH (:User {id: $userId})-[m:MEMBER_OF]->(p:Project) WHERE coalesce(p.name, p.id) = $key
         RETURN p.id AS id, coalesce(p.name, p.id) AS name, m.role AS role`,
    { key: idOrName, userId: principal.userId },
  )
  const allowed = principal.scope?.projects
  const rows = byName.records
    .map(r => ({ id: r.get('id') as string, name: r.get('name') as string, role: r.get('role') as string }))
    .filter(r => !allowed || allowed.includes(r.id))
  if (rows.length === 0) return null
  const owned = rows.filter(r => r.role === 'owner')
  const pick = owned.length === 1 ? owned : rows
  if (pick.length > 1) {
    throw new ProjectNameError(`More than one project is named "${idOrName}": use its id (${pick.map(r => r.id).join(', ')}).`, 'ambiguous')
  }
  return { id: pick[0]!.id, name: pick[0]!.name }
}

// ---- memberships -----------------------------------------------------------

export interface Member {
  userId: string
  username: string
  role: ProjectRole
  since: string | null
}

export async function listMembers(brain: Brain, projectId: string): Promise<Member[]> {
  const r = await brain.run(
    `MATCH (u:User)-[m:MEMBER_OF]->(:Project {id: $projectId})
     RETURN u.id AS userId, u.username AS username, m.role AS role, toString(m.since) AS since`,
    { projectId },
  )
  return r.records
    .map(x => ({ userId: x.get('userId') as string, username: x.get('username') as string, role: x.get('role') as ProjectRole, since: (x.get('since') as string | null) ?? null }))
    .sort((a, b) => RANK[b.role] - RANK[a.role] || a.username.localeCompare(b.username))
}

export class MembershipError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'no_such_user' | 'owner',
  ) {
    super(message)
    this.name = 'MembershipError'
  }
}

/**
 * Adds a user to a project, or changes their role. The owner role is only ever set by creating the
 * project or by `transferOwnership`, so a project always has exactly one owner.
 */
export async function setMembership(brain: Brain, projectId: string, userId: string, role: ProjectRole): Promise<void> {
  if (role === 'owner') throw new MembershipError('Use transferOwnership to change the owner.', 'owner')
  if ((await projectRole(brain, userId, projectId)) === 'owner') throw new MembershipError('The owner cannot be changed this way.', 'owner')
  const r = await brain.run(
    `MATCH (u:User {id: $userId}), (p:Project {id: $projectId})
     MERGE (u)-[m:MEMBER_OF]->(p)
       ON CREATE SET m.since = datetime()
     SET m.role = $role
     RETURN count(m) AS n`,
    { userId, projectId, role },
  )
  if (!Number(r.records[0]?.get('n'))) throw new MembershipError('No such user or project.', 'no_such_user')
}

/** Removes a user from a project. The owner cannot be removed. */
export async function removeMembership(brain: Brain, projectId: string, userId: string): Promise<boolean> {
  if ((await projectRole(brain, userId, projectId)) === 'owner') throw new MembershipError('The owner cannot be removed: transfer ownership first.', 'owner')
  const r = await brain.run(
    'MATCH (:User {id: $userId})-[m:MEMBER_OF]->(:Project {id: $projectId}) DELETE m RETURN 1 AS gone',
    { userId, projectId },
  )
  return r.records.length > 0
}

/** Makes `toUserId` the owner; the previous owner becomes a maintainer. One transaction. */
export async function transferOwnership(brain: Brain, projectId: string, toUserId: string): Promise<void> {
  const session = brain.session()
  try {
    await session.executeWrite(async tx => {
      const ok = await tx.run(
        `MATCH (u:User {id: $toUserId}), (p:Project {id: $projectId})
         OPTIONAL MATCH (:User)-[old:MEMBER_OF {role: 'owner'}]->(p)
         SET old.role = 'maintainer'
         MERGE (u)-[m:MEMBER_OF]->(p)
           ON CREATE SET m.since = datetime()
         SET m.role = 'owner'
         RETURN count(m) AS n`,
        { toUserId, projectId },
      )
      if (!Number(ok.records[0]?.get('n'))) throw new MembershipError('No such user or project.', 'no_such_user')
    })
  } finally {
    await session.close()
  }
}
