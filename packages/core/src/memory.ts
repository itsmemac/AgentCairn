import { randomUUID } from 'node:crypto'
import neo4j from 'neo4j-driver'
import type { Brain } from './db.js'

export const MEMORY_KINDS = [
  'overview',
  'decision',
  'convention',
  'gotcha',
  'checkpoint',
  'thread',
  'glossary',
  /** Where the work stands, for whoever picks it up: written by `cairn_handoff`. */
  'handoff',
] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export type MemoryStatus = 'active' | 'superseded'

export interface RememberInput {
  kind: MemoryKind
  title: string
  body: string
  /** Subsystem or module this memory is about. Case-insensitive. */
  area?: string
  /** Repo-relative paths the memory concerns; used for staleness checks. */
  paths?: string[]
  /** 1 (minor) to 5 (critical). Default 3. */
  importance?: number
  /** Ids of active memories this one replaces. They are kept as history. */
  supersedes?: string[]
  /** A line of work this belongs to (a handoff's branch). A new handoff replaces the one with the same topic. */
  topic?: string
  commitSha?: string
  author?: string
  agent?: string
  machine?: string
  /** Day (YYYY-MM-DD) after which this should be checked again; the briefing flags it as due. */
  reviewBy?: string
  /** What would make this worth revisiting: the condition under which a note, a dropped idea or a decision stops holding. */
  revisitWhen?: string
  /** Set by the server from the authenticated request, never by the client: the user who wrote it. */
  writtenBy?: string
  /** Set by the server: the name of the access token it was written with. */
  viaToken?: string
}

export interface Memory {
  id: string
  projectId: string
  kind: MemoryKind
  title: string
  body: string
  area: string | null
  paths: string[]
  importance: number
  status: MemoryStatus
  supersedes: string[]
  topic: string | null
  commitSha: string | null
  author: string | null
  agent: string | null
  machine: string | null
  reviewBy: string | null
  revisitWhen: string | null
  writtenBy: string | null
  viaToken: string | null
  createdAt: string
}

export interface RecalledMemory extends Memory {
  /** Fulltext relevance, present only for queries. */
  score: number | null
}

export interface RecallOptions {
  /** Fulltext query over title and body. Without it, memories are listed by importance and recency. */
  query?: string
  kind?: MemoryKind
  area?: string
  limit?: number
  includeSuperseded?: boolean
  /** `importance` (default: the most important first), `recent` or `oldest`. Ignored when searching text. */
  sort?: 'importance' | 'recent' | 'oldest'
}

export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryValidationError'
  }
}

export interface SupersedeProblem {
  /** The id as it was given. */
  id: string
  reason: 'not_found' | 'ambiguous' | 'replaced'
  /** For 'replaced': the active memories that replaced it, which is what to supersede instead. */
  replacedBy: string[]
}

const short = (id: string) => `#${id.slice(0, 8)}`

export class SupersedeError extends Error {
  readonly ids: string[]
  constructor(
    ids: string[],
    readonly problems: SupersedeProblem[] = [],
  ) {
    super(SupersedeError.describe(ids, problems))
    this.ids = ids
    this.name = 'SupersedeError'
  }

  private static describe(ids: string[], problems: SupersedeProblem[]): string {
    if (!problems.length) {
      return `Cannot supersede ${ids.map(i => (i.startsWith('#') ? i : `#${i}`)).join(', ')}: it changed while this was being saved. Read it again and retry.`
    }
    const parts = problems.map(p => {
      const id = p.id.startsWith('#') ? p.id : `#${p.id}`
      if (p.reason === 'replaced') {
        return p.replacedBy.length
          ? `${id} was already replaced by ${p.replacedBy.map(short).join(', ')}: supersede that instead, or leave it if this write was already saved.`
          : `${id} is already superseded.`
      }
      if (p.reason === 'ambiguous') return `${id} matches more than one memory: give more characters of the id.`
      return `${id} is not a memory of this project (check the id, and that the project is the right one).`
    })
    return `Cannot supersede: ${parts.join(' ')} Nothing was written.`
  }
}

export class ProjectMissingError extends Error {
  constructor(readonly projectId: string) {
    super(`Project "${projectId}" does not exist yet. Create it with: cairn init ${projectId} --create`)
    this.name = 'ProjectMissingError'
  }
}

const LIMITS = { title: 200, body: 20_000, area: 64, paths: 50, path: 500, supersedes: 20, revisitWhen: 500 }
export const DEFAULT_RECALL_LIMIT = 10
export const MAX_RECALL_LIMIT = 100

/** Memories filed without an area go here, so every memory has a place in the Project -> Area -> Memory tree. */
export const DEFAULT_AREA = 'general'

const normalizeArea = (area: string) => area.trim().toLowerCase()

function validate(input: RememberInput): void {
  if (!MEMORY_KINDS.includes(input.kind)) {
    throw new MemoryValidationError(`kind must be one of: ${MEMORY_KINDS.join(', ')}.`)
  }
  const title = input.title?.trim() ?? ''
  if (!title || title.length > LIMITS.title) {
    throw new MemoryValidationError(`title is required (max ${LIMITS.title} characters).`)
  }
  const body = input.body?.trim() ?? ''
  if (!body || body.length > LIMITS.body) {
    throw new MemoryValidationError(`body is required (max ${LIMITS.body} characters).`)
  }
  if (input.area !== undefined) {
    const area = normalizeArea(input.area)
    if (!area || area.length > LIMITS.area) {
      throw new MemoryValidationError(`area must be 1-${LIMITS.area} characters.`)
    }
  }
  if (input.importance !== undefined && !(Number.isInteger(input.importance) && input.importance >= 1 && input.importance <= 5)) {
    throw new MemoryValidationError('importance must be an integer from 1 to 5.')
  }
  if ((input.paths?.length ?? 0) > LIMITS.paths || input.paths?.some(p => !p || p.length > LIMITS.path)) {
    throw new MemoryValidationError(`paths: at most ${LIMITS.paths}, each 1-${LIMITS.path} characters.`)
  }
  if (input.reviewBy !== undefined && !(/^\d{4}-\d{2}-\d{2}$/.test(input.reviewBy) && !Number.isNaN(Date.parse(input.reviewBy)))) {
    throw new MemoryValidationError('review_by must be a date like 2026-12-31.')
  }
  if (input.revisitWhen !== undefined && input.revisitWhen.length > LIMITS.revisitWhen) {
    throw new MemoryValidationError(`revisit_when: at most ${LIMITS.revisitWhen} characters.`)
  }
  if ((input.supersedes?.length ?? 0) > LIMITS.supersedes) {
    throw new MemoryValidationError(`supersedes: at most ${LIMITS.supersedes} ids.`)
  }
}

const MEMORY_RETURN = `
  m{.id, .projectId, .kind, .title, .body, .importance, .status, .topic, .commitSha, .author, .agent, .machine,
    .reviewBy, .revisitWhen, .writtenBy, .viaToken,
    paths: coalesce(m.paths, []), createdAt: toString(m.createdAt)} AS m,
  [(a:Area)-[:HAS_MEMORY]->(m) | a.name][0] AS area,
  [(m)-[:SUPERSEDES]->(o:Memory) | o.id] AS supersedes`

type Row = { get(key: string): unknown }

function toMemory(row: Row): Memory {
  const m = row.get('m') as Omit<Memory, 'area' | 'supersedes'>
  return {
    ...m,
    importance: Number(m.importance),
    area: (row.get('area') as string | null) ?? null,
    supersedes: row.get('supersedes') as string[],
    topic: m.topic ?? null,
    commitSha: m.commitSha ?? null,
    author: m.author ?? null,
    agent: m.agent ?? null,
    machine: m.machine ?? null,
    reviewBy: m.reviewBy ?? null,
    revisitWhen: m.revisitWhen ?? null,
    writtenBy: m.writtenBy ?? null,
    viaToken: m.viaToken ?? null,
  }
}

/**
 * Stores a memory. When `supersedes` is given, those memories are marked
 * superseded in the same transaction (and kept as history); the call fails
 * as a whole if any of them is missing, foreign or already superseded.
 */
export async function remember(brain: Brain, projectId: string, input: RememberInput): Promise<Memory> {
  validate(input)
  const supersedes = await resolveMemoryIds(brain, projectId, input.supersedes ?? [])
  const area = input.area === undefined ? DEFAULT_AREA : normalizeArea(input.area)

  const params = {
    projectId,
    supersedes,
    area,
    areaId: `${projectId}:${area}`,
    m: {
      id: randomUUID(),
      projectId,
      kind: input.kind,
      title: input.title.trim(),
      body: input.body.trim(),
      paths: input.paths ?? [],
      importance: input.importance ?? 3,
      status: 'active',
      topic: input.topic?.trim().toLowerCase().slice(0, 64) || null,
      commitSha: input.commitSha ?? null,
      author: input.author ?? null,
      agent: input.agent ?? null,
      machine: input.machine ?? null,
      reviewBy: input.reviewBy ?? null,
      revisitWhen: input.revisitWhen?.trim() || null,
      writtenBy: input.writtenBy ?? null,
      viaToken: input.viaToken ?? null,
    },
  }

  const session = brain.session()
  try {
    const result = await session.executeWrite(tx =>
      tx.run(
        `MATCH (p:Project {id: $projectId})
         OPTIONAL MATCH (old:Memory)
           WHERE old.id IN $supersedes AND old.projectId = $projectId
         // bumping rev takes the write lock before status is read, so two
         // concurrent supersedes of one memory cannot both succeed
         SET old.rev = coalesce(old.rev, 0) + 1
         WITH p, [o IN collect(old) WHERE o IS NOT NULL AND o.status = 'active'] AS olds
         WHERE size(olds) = size($supersedes)
         CREATE (m:Memory $m)
         SET m.createdAt = datetime()
         FOREACH (o IN olds |
           SET o.status = 'superseded', o.supersededAt = datetime()
           CREATE (m)-[:SUPERSEDES]->(o))
         // containment is a tree: Project -> Area -> Memory
         MERGE (a:Area {id: $areaId})
           ON CREATE SET a.projectId = $projectId, a.name = $area
         MERGE (p)-[:HAS_AREA]->(a)
         CREATE (a)-[:HAS_MEMORY]->(m)
         RETURN ${MEMORY_RETURN}`,
        params,
      ),
    )
    const row = result.records[0]
    if (row) return toMemory(row)
  } finally {
    await session.close()
  }

  if (!(await brain.run('MATCH (p:Project {id: $projectId}) RETURN p', { projectId })).records.length) {
    throw new ProjectMissingError(projectId)
  }
  throw new SupersedeError(supersedes)
}

const MIN_ID_PREFIX = 6

/** Reads one memory by full id, or by a unique prefix of at least 6 characters (briefings show 8). */
export async function getMemory(brain: Brain, projectId: string, id: string): Promise<Memory | null> {
  if (id.length < MIN_ID_PREFIX) return null
  const r = await brain.run(
    `MATCH (m:Memory {projectId: $projectId}) WHERE m.id STARTS WITH $id
     RETURN ${MEMORY_RETURN}
     LIMIT 2`,
    { id, projectId },
  )
  return r.records.length === 1 ? toMemory(r.records[0]!) : null
}

/**
 * Resolves full ids or unique prefixes to the ids of active memories. Throws a SupersedeError that says,
 * for each id that does not qualify, why not: unknown, ambiguous, or already replaced (and by what).
 */
export async function resolveMemoryIds(brain: Brain, projectId: string, ids: readonly string[]): Promise<string[]> {
  const resolved: string[] = []
  const problems: SupersedeProblem[] = []
  for (const raw of ids) {
    const id = raw.replace(/^#/, '')
    const found =
      id.length >= MIN_ID_PREFIX
        ? await brain.run(
            `MATCH (m:Memory {projectId: $projectId}) WHERE m.id STARTS WITH $id
             OPTIONAL MATCH (n:Memory {projectId: $projectId, status: 'active'})-[:SUPERSEDES*1..20]->(m)
             RETURN m.id AS id, m.status AS status, collect(DISTINCT n.id) AS heads
             LIMIT 3`,
            { id, projectId },
          )
        : null
    const rows = found?.records ?? []
    if (rows.length === 0) problems.push({ id: raw, reason: 'not_found', replacedBy: [] })
    else if (rows.length > 1) problems.push({ id: raw, reason: 'ambiguous', replacedBy: [] })
    else if (rows[0]!.get('status') !== 'active') problems.push({ id: raw, reason: 'replaced', replacedBy: rows[0]!.get('heads') as string[] })
    else resolved.push(rows[0]!.get('id') as string)
  }
  if (problems.length) throw new SupersedeError(problems.map(p => p.id), problems)
  return [...new Set(resolved)]
}

export interface AreaSummary {
  name: string
  /** Active memories about the area. */
  count: number
}

export async function listAreas(brain: Brain, projectId: string): Promise<AreaSummary[]> {
  const r = await brain.run(
    `MATCH (:Project {id: $projectId})-[:HAS_AREA]->(a:Area)
     OPTIONAL MATCH (a)-[:HAS_MEMORY]->(m:Memory {status: 'active'})
     RETURN a.name AS name, count(m) AS count
     ORDER BY count DESC, name`,
    { projectId },
  )
  return r.records.map(row => ({ name: row.get('name') as string, count: Number(row.get('count')) }))
}

/**
 * Deletes a memory (full id or unique prefix). Memories it superseded come
 * back to life unless another memory also superseded them. Returns null when
 * nothing matches.
 */
export async function forgetMemory(
  brain: Brain,
  projectId: string,
  id: string,
): Promise<{ id: string; title: string; restored: string[] } | null> {
  const memory = await getMemory(brain, projectId, id)
  if (!memory) return null
  const r = await brain.run(
    `MATCH (m:Memory {id: $id, projectId: $projectId})
     OPTIONAL MATCH (m)-[:SUPERSEDES]->(o:Memory)
       WHERE NOT EXISTS { (x:Memory)-[:SUPERSEDES]->(o) WHERE x <> m }
     SET o.status = 'active'
     REMOVE o.supersededAt
     WITH m, [x IN collect(o) WHERE x IS NOT NULL | x.id] AS restored
     DETACH DELETE m
     RETURN restored`,
    { id: memory.id, projectId },
  )
  return { id: memory.id, title: memory.title, restored: (r.records[0]?.get('restored') as string[]) ?? [] }
}

/** Escapes Lucene syntax so free text from an agent can never be a parse error. */
export function toLuceneQuery(text: string): string {
  return text
    .split(/\s+/)
    .map(term => term.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&'))
    .filter(Boolean)
    .join(' ')
}

export async function recall(
  brain: Brain,
  projectId: string,
  options: RecallOptions = {},
): Promise<RecalledMemory[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_RECALL_LIMIT), 1), MAX_RECALL_LIMIT)
  const area = options.area === undefined ? null : normalizeArea(options.area)
  const common = {
    projectId,
    kind: options.kind ?? null,
    areaId: area === null ? null : `${projectId}:${area}`,
    includeSuperseded: options.includeSuperseded ?? false,
    limit: neo4j.int(limit),
  }
  const filter = `m.projectId = $projectId
    AND ($includeSuperseded OR m.status = 'active')
    AND ($kind IS NULL OR m.kind = $kind)
    AND ($areaId IS NULL OR EXISTS { (:Area {id: $areaId})-[:HAS_MEMORY]->(m) })`

  const text = toLuceneQuery(options.query ?? '')
  if (text) {
    const r = await brain.run(
      `CALL db.index.fulltext.queryNodes('memory_text', $text) YIELD node AS m, score
       WHERE ${filter}
       RETURN ${MEMORY_RETURN}, score
       ORDER BY score * (0.5 + m.importance / 5.0) DESC, m.createdAt DESC
       LIMIT $limit`,
      { ...common, text },
    )
    return r.records.map(row => ({ ...toMemory(row), score: Number(row.get('score')) }))
  }

  const r = await brain.run(
    `MATCH (m:Memory) WHERE ${filter}
     RETURN ${MEMORY_RETURN}
     ORDER BY ${
       options.sort === 'recent' ? 'm.createdAt DESC, m.importance DESC' : options.sort === 'oldest' ? 'm.createdAt ASC, m.importance DESC' : 'm.importance DESC, m.createdAt DESC'
     }
     LIMIT $limit`,
    common,
  )
  return r.records.map(row => ({ ...toMemory(row), score: null }))
}

export interface StaleInput {
  id: string
  commitSha: string
  paths: string[]
}

/**
 * What a client needs to compute staleness itself: the commit and paths of
 * every active memory that has both. Used when the server cannot see the repo.
 */
export async function listStaleInputs(brain: Brain, projectId: string, limit = 1000): Promise<StaleInput[]> {
  const r = await brain.run(
    `MATCH (m:Memory {projectId: $projectId, status: 'active'})
     WHERE m.commitSha IS NOT NULL AND size(coalesce(m.paths, [])) > 0
     RETURN m.id AS id, m.commitSha AS commitSha, m.paths AS paths
     ORDER BY m.createdAt DESC
     LIMIT $limit`,
    { projectId, limit: neo4j.int(limit) },
  )
  return r.records.map(row => ({
    id: row.get('id') as string,
    commitSha: row.get('commitSha') as string,
    paths: row.get('paths') as string[],
  }))
}
