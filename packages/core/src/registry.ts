import { type Principal, ProjectNameError } from './access.js'
import type { Brain } from './db.js'

export class RemoteConflictError extends Error {
  constructor(
    readonly remoteHash: string,
    readonly ownerProjectId: string,
  ) {
    super(`This git remote already belongs to project "${ownerProjectId}".`)
    this.name = 'RemoteConflictError'
  }
}

export async function projectExists(brain: Brain, id: string): Promise<boolean> {
  const r = await brain.run('MATCH (p:Project {id: $id}) RETURN count(p) AS n', { id })
  return Number(r.records[0]?.get('n')) > 0
}

/**
 * Creates a project with exactly this id (and the id as its name) when it is missing. This is the
 * low-level form, for fixtures and old data; projects made on behalf of a user go through
 * `createProject`, which generates the id and records the owner.
 */
export async function ensureProject(brain: Brain, id: string): Promise<{ created: boolean }> {
  const before = await projectExists(brain, id)
  await brain.run(
    `MERGE (p:Project {id: $id})
     ON CREATE SET p.createdAt = datetime()
     SET p.name = coalesce(p.name, $id)`,
    { id },
  )
  return { created: !before }
}

export interface DeletedProject {
  memories: number
  areas: number
  remotes: number
}

/**
 * Removes a project with everything under it: its memories (active and superseded), areas, the git
 * remotes registered to it and its memberships. Returns null when the project does not exist. One
 * transaction, so a failure leaves it whole.
 */
export async function deleteProject(brain: Brain, id: string): Promise<DeletedProject | null> {
  const session = brain.session()
  try {
    return await session.executeWrite(async tx => {
      const count = async (query: string) => Number((await tx.run(query, { id })).records[0]?.get('n') ?? 0)
      if (!(await count('MATCH (p:Project {id: $id}) RETURN count(p) AS n'))) return null
      const memories = await count('MATCH (m:Memory {projectId: $id}) RETURN count(m) AS n')
      const areas = await count('MATCH (a:Area {projectId: $id}) RETURN count(a) AS n')
      const remotes = await count('MATCH (r:Remote)-[:BELONGS_TO]->(:Project {id: $id}) RETURN count(r) AS n')
      await tx.run('MATCH (m:Memory {projectId: $id}) DETACH DELETE m', { id })
      await tx.run('MATCH (a:Area {projectId: $id}) DETACH DELETE a', { id })
      await tx.run('MATCH (r:Remote)-[:BELONGS_TO]->(:Project {id: $id}) DETACH DELETE r', { id })
      await tx.run('MATCH (p:Project {id: $id}) DETACH DELETE p', { id })
      return { memories, areas, remotes }
    })
  } finally {
    await session.close()
  }
}

/** Remote aliases belong to a project, so the same repository can map to different projects for different people. */
export const remoteKey = (projectId: string, hash: string) => `${projectId}:${hash}`

interface RemoteMatch {
  id: string
  role: string
}

/** Projects with this remote that the principal can access, owned ones first. Without a principal: all of them. */
async function projectsWithRemote(brain: Brain, hash: string, principal?: Principal): Promise<RemoteMatch[]> {
  const everything = !principal || Boolean(principal.solo)
  const r = await brain.run(
    `MATCH (:Remote {hash: $hash})-[:BELONGS_TO]->(p:Project)
     OPTIONAL MATCH (:User {id: $userId})-[m:MEMBER_OF]->(p)
     WITH p, m WHERE $everything OR m IS NOT NULL
     RETURN p.id AS id, coalesce(m.role, 'owner') AS role`,
    { hash, userId: principal?.userId ?? '', everything },
  )
  return r.records
    .map(x => ({ id: x.get('id') as string, role: x.get('role') as string }))
    .sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner'))
}

/**
 * The project a git remote maps to for this person. With several, an owned one wins; otherwise the
 * caller has to say which with an id.
 */
export async function findProjectByRemote(brain: Brain, hash: string, principal?: Principal): Promise<string | null> {
  const found = await projectsWithRemote(brain, hash, principal)
  if (found.length === 0) return null
  const owned = found.filter(f => f.role === 'owner')
  const pick = owned.length === 1 ? owned : found
  if (pick.length > 1) {
    throw new ProjectNameError(`More than one project uses this git remote (${pick.map(p => p.id).join(', ')}): use a project id.`, 'ambiguous')
  }
  return pick[0]!.id
}

/** Attaches a remote to a project. Another project of yours with the same remote is a conflict unless `force` moves it. */
export async function attachRemote(
  brain: Brain,
  projectId: string,
  hash: string,
  options: { force?: boolean; principal?: Principal } = {},
): Promise<void> {
  const others = (await projectsWithRemote(brain, hash, options.principal)).filter(p => p.id !== projectId)
  if (others.length && !options.force) throw new RemoteConflictError(hash, others[0]!.id)
  if (others.length) {
    await brain.run(
      'MATCH (r:Remote {hash: $hash})-[:BELONGS_TO]->(p:Project) WHERE p.id IN $ids DETACH DELETE r',
      { hash, ids: others.map(o => o.id) },
    )
  }
  await brain.run(
    `MATCH (p:Project {id: $projectId})
     MERGE (r:Remote {key: $key})
       ON CREATE SET r.hash = $hash, r.createdAt = datetime()
     MERGE (r)-[:BELONGS_TO]->(p)`,
    { projectId, hash, key: remoteKey(projectId, hash) },
  )
}
