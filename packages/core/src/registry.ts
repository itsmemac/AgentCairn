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

export async function ensureProject(brain: Brain, id: string): Promise<{ created: boolean }> {
  const before = await projectExists(brain, id)
  await brain.run(
    `MERGE (p:Project {id: $id})
     ON CREATE SET p.createdAt = datetime()`,
    { id },
  )
  return { created: !before }
}

export async function findProjectByRemote(brain: Brain, hash: string): Promise<string | null> {
  const r = await brain.run(
    'MATCH (:Remote {hash: $hash})-[:BELONGS_TO]->(p:Project) RETURN p.id AS id',
    { hash },
  )
  return (r.records[0]?.get('id') as string | undefined) ?? null
}

/** Attaches a remote to a project. A remote belongs to one project; moving it needs `force`. */
export async function attachRemote(
  brain: Brain,
  projectId: string,
  hash: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const owner = await findProjectByRemote(brain, hash)
  if (owner && owner !== projectId && !options.force) {
    throw new RemoteConflictError(hash, owner)
  }
  await brain.run(
    `MATCH (p:Project {id: $projectId})
     MERGE (r:Remote {hash: $hash})
       ON CREATE SET r.createdAt = datetime()
     WITH p, r
     OPTIONAL MATCH (r)-[old:BELONGS_TO]->(:Project)
     DELETE old
     MERGE (r)-[:BELONGS_TO]->(p)`,
    { projectId, hash },
  )
}
