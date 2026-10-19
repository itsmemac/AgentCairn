import neo4j from 'neo4j-driver'
import type { Brain } from './db.js'
import { clip, sanitize } from './redact.js'

/**
 * A session is one conversation between a person and an agent in a project folder. It is recorded
 * mechanically (no LLM, no agent effort) from the transcript and the repository, as it goes, so that
 * another agent on another machine can see what was asked and what state the work was left in, even
 * when the machine the session ran on is gone.
 */

export interface SessionPrompt {
  at: string | null
  text: string
}

export interface SessionInput {
  /** Identifies the session: the agent runtime's own session id. */
  sessionId: string
  machine?: string
  agent?: string
  author?: string
  startedAt?: string
  endedAt?: string
  branch?: string
  head?: string
  headSubject?: string
  /** Files with uncommitted changes when the snapshot was taken. */
  dirty?: string[]
  /** Files the agent edited during the session. */
  touched?: string[]
  /** Commits made during the session, as `abc1234 subject`. */
  commits?: string[]
  /** What the person asked: the first prompt and the most recent ones. */
  prompts?: { at?: string; text: string }[]
  /** The agent's last message: its own account of where things stand. */
  lastReply?: string
  /** How many times each tool was used. */
  tools?: Record<string, number>
}

export interface SessionRecord {
  id: string
  projectId: string
  machine: string | null
  agent: string | null
  author: string | null
  startedAt: string | null
  updatedAt: string
  endedAt: string | null
  branch: string | null
  head: string | null
  headSubject: string | null
  dirty: string[]
  touched: string[]
  commits: string[]
  prompts: SessionPrompt[]
  lastReply: string | null
  tools: Record<string, number>
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionError'
  }
}

export const SESSION_LIMITS = { prompts: 8, prompt: 800, reply: 3000, files: 120, dirty: 60, commits: 25, path: 300, line: 200 } as const

const SESSION_ID = /^[A-Za-z0-9._:-]{1,100}$/

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? clip(v, max) : null)
const list = (v: unknown, max: number, each: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, max).map(x => clip(x, each)) : []

/** Validates and shortens a snapshot, and removes secrets from everything a person or agent wrote. */
export function normalizeSession(input: SessionInput): Required<Omit<SessionInput, 'tools' | 'prompts'>> & {
  prompts: SessionPrompt[]
  tools: Record<string, number>
} {
  if (typeof input.sessionId !== 'string' || !SESSION_ID.test(input.sessionId)) {
    throw new SessionError('sessionId is required (letters, digits, ".", "_", ":" or "-", up to 100 characters).')
  }
  const L = SESSION_LIMITS
  const prompts = (Array.isArray(input.prompts) ? input.prompts : [])
    .filter(p => p && typeof p.text === 'string' && p.text.trim() !== '')
    .slice(0, L.prompts)
    .map(p => ({ at: typeof p.at === 'string' ? clip(p.at, 40) : null, text: sanitize(p.text, L.prompt) }))
  const tools: Record<string, number> = {}
  for (const [name, n] of Object.entries(input.tools ?? {}).slice(0, 40)) {
    if (Number.isFinite(n)) tools[clip(name, 60)] = Math.max(0, Math.trunc(n))
  }
  return {
    sessionId: input.sessionId,
    machine: text(input.machine, 100) ?? '',
    agent: text(input.agent, 100) ?? '',
    author: text(input.author, 100) ?? '',
    startedAt: text(input.startedAt, 40) ?? '',
    endedAt: text(input.endedAt, 40) ?? '',
    branch: text(input.branch, 200) ?? '',
    head: text(input.head, 64) ?? '',
    headSubject: sanitize(input.headSubject ?? '', L.line),
    dirty: list(input.dirty, L.dirty, L.path),
    touched: list(input.touched, L.files, L.path),
    commits: list(input.commits, L.commits, L.line).map(c => sanitize(c, L.line)),
    prompts,
    lastReply: sanitize(input.lastReply ?? '', L.reply),
    tools,
  }
}

const RETURN = `s.id AS id, s.projectId AS projectId, s.machine AS machine, s.agent AS agent, s.author AS author,
  s.startedAt AS startedAt, toString(s.updatedAt) AS updatedAt, s.endedAt AS endedAt, s.branch AS branch,
  s.head AS head, s.headSubject AS headSubject, coalesce(s.dirty, []) AS dirty, coalesce(s.touched, []) AS touched,
  coalesce(s.commits, []) AS commits, s.promptsJson AS promptsJson, s.lastReply AS lastReply, s.toolsJson AS toolsJson`

type Row = { get(key: string): unknown }

const parse = <T>(json: unknown, fallback: T): T => {
  try {
    return typeof json === 'string' ? (JSON.parse(json) as T) : fallback
  } catch {
    return fallback
  }
}
const orNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

function toSession(row: Row): SessionRecord {
  return {
    id: row.get('id') as string,
    projectId: row.get('projectId') as string,
    machine: orNull(row.get('machine')),
    agent: orNull(row.get('agent')),
    author: orNull(row.get('author')),
    startedAt: orNull(row.get('startedAt')),
    updatedAt: row.get('updatedAt') as string,
    endedAt: orNull(row.get('endedAt')),
    branch: orNull(row.get('branch')),
    head: orNull(row.get('head')),
    headSubject: orNull(row.get('headSubject')),
    dirty: row.get('dirty') as string[],
    touched: row.get('touched') as string[],
    commits: row.get('commits') as string[],
    prompts: parse<SessionPrompt[]>(row.get('promptsJson'), []),
    lastReply: orNull(row.get('lastReply')),
    tools: parse<Record<string, number>>(row.get('toolsJson'), {}),
  }
}

/**
 * Records a snapshot of a session. Snapshots are cumulative, so the same session is simply updated
 * each time (the call is idempotent), and an empty field never erases something recorded earlier.
 */
export async function upsertSession(brain: Brain, projectId: string, input: SessionInput): Promise<SessionRecord> {
  const s = normalizeSession(input)
  const r = await brain.run(
    `MATCH (p:Project {id: $projectId})
     MERGE (s:Session {key: $key})
       ON CREATE SET s.id = $id, s.projectId = $projectId, s.createdAt = datetime()
     SET s.updatedAt = datetime(),
         s.machine = CASE WHEN $machine = '' THEN s.machine ELSE $machine END,
         s.agent = CASE WHEN $agent = '' THEN s.agent ELSE $agent END,
         s.author = CASE WHEN $author = '' THEN s.author ELSE $author END,
         s.startedAt = coalesce(s.startedAt, CASE WHEN $startedAt = '' THEN null ELSE $startedAt END),
         s.endedAt = CASE WHEN $endedAt = '' THEN s.endedAt ELSE $endedAt END,
         s.branch = CASE WHEN $branch = '' THEN s.branch ELSE $branch END,
         s.head = CASE WHEN $head = '' THEN s.head ELSE $head END,
         s.headSubject = CASE WHEN $headSubject = '' THEN s.headSubject ELSE $headSubject END,
         s.dirty = $dirty,
         s.touched = CASE WHEN size($touched) = 0 THEN coalesce(s.touched, []) ELSE $touched END,
         s.commits = CASE WHEN size($commits) = 0 THEN coalesce(s.commits, []) ELSE $commits END,
         s.promptsJson = CASE WHEN $promptsJson = '[]' THEN s.promptsJson ELSE $promptsJson END,
         s.lastReply = CASE WHEN $lastReply = '' THEN s.lastReply ELSE $lastReply END,
         s.toolsJson = CASE WHEN $toolsJson = '{}' THEN s.toolsJson ELSE $toolsJson END
     MERGE (p)-[:HAS_SESSION]->(s)
     RETURN ${RETURN}`,
    {
      projectId,
      key: `${projectId}:${s.sessionId}`,
      id: s.sessionId,
      machine: s.machine,
      agent: s.agent,
      author: s.author,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      branch: s.branch,
      head: s.head,
      headSubject: s.headSubject,
      dirty: s.dirty,
      touched: s.touched,
      commits: s.commits,
      promptsJson: JSON.stringify(s.prompts),
      lastReply: s.lastReply,
      toolsJson: JSON.stringify(s.tools),
    },
  )
  const row = r.records[0]
  if (!row) throw new SessionError(`Project "${projectId}" does not exist.`)
  return toSession(row)
}

/** The most recently active sessions of a project, newest first. */
export async function listSessions(brain: Brain, projectId: string, options: { limit?: number } = {}): Promise<SessionRecord[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 10), 1), 50)
  const r = await brain.run(
    `MATCH (:Project {id: $projectId})-[:HAS_SESSION]->(s:Session)
     RETURN ${RETURN} ORDER BY s.updatedAt DESC LIMIT $limit`,
    { projectId, limit: neo4j.int(limit) },
  )
  return r.records.map(toSession)
}
