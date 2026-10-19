import neo4j from 'neo4j-driver'
import type { Brain } from './db.js'
import { listAreas, type AreaSummary } from './memory.js'

/** Plain-JSON form of any Neo4j value (integers, dates, nodes, relationships, paths). */
export function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (neo4j.isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toString()
  if (
    neo4j.isDateTime(value) ||
    neo4j.isDate(value) ||
    neo4j.isTime(value) ||
    neo4j.isLocalDateTime(value) ||
    neo4j.isLocalTime(value) ||
    neo4j.isDuration(value)
  ) {
    return value.toString()
  }
  if (value instanceof neo4j.types.Node) {
    return { _type: 'node', id: value.elementId, labels: value.labels, properties: toPlain(value.properties) }
  }
  if (value instanceof neo4j.types.Relationship) {
    return {
      _type: 'relationship',
      id: value.elementId,
      type: value.type,
      from: value.startNodeElementId,
      to: value.endNodeElementId,
      properties: toPlain(value.properties),
    }
  }
  if (value instanceof neo4j.types.Path) {
    return {
      _type: 'path',
      nodes: [value.start, ...value.segments.map(s => s.end)].map(toPlain),
      relationships: value.segments.map(s => toPlain(s.relationship)),
    }
  }
  if (Array.isArray(value)) return value.map(toPlain)
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toPlain(v)]))
  }
  return value
}

// ---- projects --------------------------------------------------------------

export interface ProjectOverview {
  id: string
  name: string
  /** The owner's username; null for a project with no owner (a very old one). */
  owner: string | null
  createdAt: string
  counts: Record<string, number>
  active: number
  superseded: number
  remotes: number
  lastMemoryAt: string | null
}

/** `projectIds` limits the list to those projects (what a signed-in user may see); null or absent means all. */
export async function listProjects(brain: Brain, options: { projectIds?: string[] | null } = {}): Promise<ProjectOverview[]> {
  const ids = options.projectIds ?? null
  const [mem, rem, own] = await Promise.all([
    brain.run(
      `MATCH (p:Project) WHERE $ids IS NULL OR p.id IN $ids
       OPTIONAL MATCH (m:Memory {projectId: p.id})
       RETURN p.id AS id, coalesce(p.name, p.id) AS name, toString(p.createdAt) AS createdAt, m.kind AS kind, m.status AS status,
              count(m) AS n, toString(max(m.createdAt)) AS last`,
      { ids },
    ),
    brain.run('MATCH (r:Remote)-[:BELONGS_TO]->(p:Project) RETURN p.id AS id, count(r) AS n'),
    brain.run("MATCH (u:User)-[:MEMBER_OF {role: 'owner'}]->(p:Project) RETURN p.id AS id, u.username AS owner"),
  ])
  const owners = new Map(own.records.map(r => [r.get('id') as string, r.get('owner') as string]))
  const remotes = new Map(rem.records.map(r => [r.get('id') as string, Number(r.get('n'))]))
  const byId = new Map<string, ProjectOverview>()
  for (const row of mem.records) {
    const id = row.get('id') as string
    const p =
      byId.get(id) ??
      { id, name: row.get('name') as string, owner: owners.get(id) ?? null, createdAt: row.get('createdAt') as string, counts: {}, active: 0, superseded: 0, remotes: remotes.get(id) ?? 0, lastMemoryAt: null }
    byId.set(id, p)
    const kind = row.get('kind') as string | null
    if (kind === null) continue
    const n = Number(row.get('n'))
    if (row.get('status') === 'active') {
      p.counts[kind] = (p.counts[kind] ?? 0) + n
      p.active += n
    } else p.superseded += n
    const last = row.get('last') as string | null
    if (last && (!p.lastMemoryAt || last > p.lastMemoryAt)) p.lastMemoryAt = last
  }
  return [...byId.values()].sort((a, b) => (b.lastMemoryAt ?? b.createdAt).localeCompare(a.lastMemoryAt ?? a.createdAt))
}

export interface ProjectDetail extends ProjectOverview {
  areas: AreaSummary[]
  /** First characters of the hashes of the git remotes that map here. */
  remoteHashes: string[]
}

export async function getProjectDetail(brain: Brain, id: string): Promise<ProjectDetail | null> {
  const overview = (await listProjects(brain)).find(p => p.id === id)
  if (!overview) return null
  const [areas, remotes] = await Promise.all([
    listAreas(brain, id),
    brain.run('MATCH (r:Remote)-[:BELONGS_TO]->(:Project {id: $id}) RETURN r.hash AS hash ORDER BY hash', { id }),
  ])
  return { ...overview, areas, remoteHashes: remotes.records.map(r => (r.get('hash') as string).slice(0, 8)) }
}

export interface MemoryChain {
  id: string
  title: string
  status: string
  createdAt: string
}

/** The memories this one replaced (oldest last) and the ones that replaced it. */
export async function getMemoryChain(
  brain: Brain,
  projectId: string,
  id: string,
): Promise<{ replaced: MemoryChain[]; replacedBy: MemoryChain[] }> {
  const pick = `x.id AS id, x.title AS title, x.status AS status, toString(x.createdAt) AS createdAt`
  const [older, newer] = await Promise.all([
    brain.run(
      `MATCH (m:Memory {id: $id, projectId: $projectId})-[:SUPERSEDES*1..20]->(x:Memory) RETURN DISTINCT ${pick} ORDER BY createdAt DESC`,
      { id, projectId },
    ),
    brain.run(
      `MATCH (x:Memory)-[:SUPERSEDES*1..20]->(m:Memory {id: $id, projectId: $projectId}) RETURN DISTINCT ${pick} ORDER BY createdAt ASC`,
      { id, projectId },
    ),
  ])
  const map = (r: { get(k: string): unknown }): MemoryChain => ({
    id: r.get('id') as string,
    title: r.get('title') as string,
    status: r.get('status') as string,
    createdAt: r.get('createdAt') as string,
  })
  return { replaced: older.records.map(map), replacedBy: newer.records.map(map) }
}

// ---- graph -----------------------------------------------------------------

export interface GraphNode {
  id: string
  type: 'project' | 'area' | 'memory' | 'remote'
  label: string
  data: Record<string, unknown>
}
export interface GraphEdge {
  id: string
  source: string
  target: string
  type: 'HAS_AREA' | 'HAS_MEMORY' | 'SUPERSEDES' | 'BELONGS_TO'
}
export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  truncated: boolean
}

/**
 * Overview (no project): projects, their areas and remotes. With a project:
 * its areas and memories (the most important and recent first, up to `limit`)
 * linked by what they are about and what they replaced.
 */
export async function getGraph(brain: Brain, options: { projectId?: string; projectIds?: string[] | null; limit?: number } = {}): Promise<Graph> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 300), 1), 1000)
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const edge = (type: GraphEdge['type'], source: string, target: string) =>
    edges.push({ id: `${type}:${source}>${target}`, source, target, type })
  const where = 'WHERE ($projectId IS NULL OR p.id = $projectId) AND ($ids IS NULL OR p.id IN $ids)'
  const params = { projectId: options.projectId ?? null, ids: options.projectIds ?? null }

  const projects = await brain.run(`MATCH (p:Project) ${where} RETURN p.id AS id, coalesce(p.name, p.id) AS name, toString(p.createdAt) AS createdAt`, params)
  for (const r of projects.records) {
    const id = r.get('id') as string
    nodes.set(`p:${id}`, { id: `p:${id}`, type: 'project', label: r.get('name') as string, data: { id, createdAt: r.get('createdAt') } })
  }

  const areas = await brain.run(
    `MATCH (p:Project)-[:HAS_AREA]->(a:Area) ${where}
     OPTIONAL MATCH (a)-[:HAS_MEMORY]->(m:Memory {status: 'active'})
     RETURN p.id AS project, a.name AS name, count(m) AS n`,
    params,
  )
  for (const r of areas.records) {
    const project = r.get('project') as string
    const name = r.get('name') as string
    const id = `a:${project}:${name}`
    nodes.set(id, { id, type: 'area', label: name, data: { project, memories: Number(r.get('n')) } })
    edge('HAS_AREA', `p:${project}`, id)
  }

  const remotes = await brain.run(
    `MATCH (r:Remote)-[:BELONGS_TO]->(p:Project) ${where} RETURN p.id AS project, r.hash AS hash`,
    params,
  )
  for (const r of remotes.records) {
    const project = r.get('project') as string
    const hash = r.get('hash') as string
    const id = `r:${hash}`
    nodes.set(id, { id, type: 'remote', label: hash.slice(0, 8), data: { project, hash } })
    edge('BELONGS_TO', id, `p:${project}`)
  }

  let truncated = false
  if (options.projectId) {
    const mem = await brain.run(
      `MATCH (m:Memory {projectId: $projectId})
       WITH m ORDER BY CASE m.status WHEN 'active' THEN 0 ELSE 1 END, m.importance DESC, m.createdAt DESC
       LIMIT $limit
       RETURN m.id AS id, m.kind AS kind, m.title AS title, m.status AS status, m.importance AS importance,
              toString(m.createdAt) AS createdAt, [(a:Area)-[:HAS_MEMORY]->(m) | a.name][0] AS area`,
      { projectId: options.projectId, limit: neo4j.int(limit + 1) },
    )
    const rows = mem.records.slice(0, limit)
    truncated = mem.records.length > limit
    for (const r of rows) {
      const id = r.get('id') as string
      const area = r.get('area') as string | null
      nodes.set(`m:${id}`, {
        id: `m:${id}`,
        type: 'memory',
        label: r.get('title') as string,
        data: {
          id,
          kind: r.get('kind'),
          status: r.get('status'),
          importance: Number(r.get('importance')),
          createdAt: r.get('createdAt'),
          area,
        },
      })
      // parent -> child, like the database: Area -> Memory (a memory without an area hangs off the project)
      edge('HAS_MEMORY', area ? `a:${options.projectId}:${area}` : `p:${options.projectId}`, `m:${id}`)
    }
    const links = await brain.run(
      `MATCH (a:Memory {projectId: $projectId})-[:SUPERSEDES]->(b:Memory) RETURN a.id AS a, b.id AS b`,
      { projectId: options.projectId },
    )
    for (const r of links.records) {
      const [a, b] = [`m:${r.get('a')}`, `m:${r.get('b')}`]
      if (nodes.has(a) && nodes.has(b)) edge('SUPERSEDES', a, b)
    }
  }

  return { nodes: [...nodes.values()], edges: edges.filter(e => nodes.has(e.source) && nodes.has(e.target)), truncated }
}

// ---- read-only Cypher ------------------------------------------------------

export class QueryRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueryRejectedError'
  }
}

const FORBIDDEN =
  /\b(create|merge|delete|detach|set|remove|drop|foreach|load\s+csv|periodic|dbms|apoc|grant|deny|revoke|alter|start|stop|terminate|use)\b/i

function stripLiterals(query: string): string {
  return query
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`/g, "''")
}

/**
 * Defence in depth: a keyword screen here, and the database itself runs the
 * statement in a read transaction, which refuses writes whatever the text says.
 */
export function assertReadOnlyCypher(query: string): void {
  if (!query.trim()) throw new QueryRejectedError('Query is empty.')
  if (query.length > 5000) throw new QueryRejectedError('Query is too long (max 5000 characters).')
  const bare = stripLiterals(query)
  const hit = FORBIDDEN.exec(bare)
  if (hit) throw new QueryRejectedError(`"${hit[1]}" is not allowed: the console is read-only.`)
  if (bare.includes(';') && bare.trim().replace(/;$/, '').includes(';')) {
    throw new QueryRejectedError('Run one statement at a time.')
  }
}

export interface CypherResult {
  columns: string[]
  rows: unknown[][]
  truncated: boolean
  elapsedMs: number
}

export async function runReadOnlyCypher(
  brain: Brain,
  query: string,
  options: { limit?: number; timeoutMs?: number } = {},
): Promise<CypherResult> {
  assertReadOnlyCypher(query)
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), 1000)
  const started = Date.now()
  const session = brain.session()
  try {
    const result = await session.executeRead(tx => tx.run(query), { timeout: options.timeoutMs ?? 10_000 })
    return {
      columns: result.records[0]?.keys.map(String) ?? [],
      rows: result.records.slice(0, limit).map(r => r.keys.map(k => toPlain(r.get(k)))),
      truncated: result.records.length > limit,
      elapsedMs: Date.now() - started,
    }
  } finally {
    await session.close()
  }
}

// ---- system ----------------------------------------------------------------

export interface SystemInfo {
  labels: Record<string, number>
  relationships: Record<string, number>
}

export async function getSystemInfo(brain: Brain): Promise<SystemInfo> {
  const [nodes, rels] = await Promise.all([
    brain.run('MATCH (n) UNWIND labels(n) AS l RETURN l, count(*) AS n ORDER BY n DESC'),
    brain.run('MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS n ORDER BY n DESC'),
  ])
  return {
    labels: Object.fromEntries(nodes.records.map(r => [r.get('l') as string, Number(r.get('n'))])),
    relationships: Object.fromEntries(rels.records.map(r => [r.get('t') as string, Number(r.get('n'))])),
  }
}
