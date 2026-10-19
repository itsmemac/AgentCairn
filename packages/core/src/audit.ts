import { randomUUID } from 'node:crypto'
import neo4j from 'neo4j-driver'
import type { Brain } from './db.js'
import { clip, sanitize } from './redact.js'

/**
 * A record of who changed what: accounts, invitations, sharing, tokens, projects and use of the raw
 * query console. It is for the admin to answer "who did that?", so it is written best-effort (a failed
 * write never fails the action) and kept for 180 days. It never stores secrets or memory content.
 */

export interface AuditInput {
  /** Username of the person who did it, or null for the system. */
  actor: string | null
  /** A dotted name: `invite.created`, `member.changed`, `user.removed`, … */
  action: string
  /** What it was done to: a username, a project name, a token name. */
  target?: string | null
  /** A short extra: the role, the old value, the reason. */
  detail?: string | null
}

export interface AuditEvent {
  id: string
  at: string
  actor: string | null
  action: string
  target: string | null
  detail: string | null
}

const RETENTION_DAYS = 180

export async function recordAudit(brain: Brain, event: AuditInput): Promise<void> {
  try {
    await brain.run(
      `CREATE (:Audit {id: $id, at: datetime(), actor: $actor, action: $action, target: $target, detail: $detail})`,
      {
        id: randomUUID(),
        actor: event.actor ? clip(event.actor, 64) : null,
        action: clip(event.action, 64),
        target: event.target ? sanitize(event.target, 200) : null,
        detail: event.detail ? sanitize(event.detail, 300) : null,
      },
    )
    // housekeeping: now and then, drop what is older than the retention period
    if (Math.random() < 0.01) {
      await brain.run(`MATCH (a:Audit) WHERE a.at < datetime() - duration({days: $days}) DETACH DELETE a`, { days: RETENTION_DAYS })
    }
  } catch {
    // auditing must never break what is being audited
  }
}

/** Newest first. `before` is the `at` of the last event already shown; `action` matches a prefix (`invite.`). */
export async function listAudit(brain: Brain, options: { limit?: number; before?: string; action?: string } = {}): Promise<AuditEvent[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500)
  const r = await brain.run(
    `MATCH (a:Audit)
     WHERE ($before IS NULL OR a.at < datetime($before)) AND ($action IS NULL OR a.action STARTS WITH $action)
     RETURN a.id AS id, toString(a.at) AS at, a.actor AS actor, a.action AS action, a.target AS target, a.detail AS detail
     ORDER BY a.at DESC LIMIT $limit`,
    { before: options.before ?? null, action: options.action ?? null, limit: neo4j.int(limit) },
  )
  return r.records.map(x => ({
    id: x.get('id') as string,
    at: x.get('at') as string,
    actor: (x.get('actor') as string | null) ?? null,
    action: x.get('action') as string,
    target: (x.get('target') as string | null) ?? null,
    detail: (x.get('detail') as string | null) ?? null,
  }))
}
