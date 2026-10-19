import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  type InstanceRole,
  type Principal,
  type ProjectRole,
  authorize,
  isInstanceRole,
  isProjectRole,
} from './access.js'
import { type UserRecord, getUserById, hashPassword, validateCredentials } from './admin.js'
import type { Brain } from './db.js'

/**
 * Invitations are how people join. An admin makes a link; whoever opens it chooses a username and a
 * password, and an account is created. The link is a 256-bit random secret that is only ever stored as a
 * hash, works once, and expires. No mail server is needed: the admin sends the link however they like.
 * A \`reset\` invitation is the same for an existing account that needs a new password.
 */

export type InviteKind = 'join' | 'reset'

export interface InviteGrant {
  projectId: string
  role: Exclude<ProjectRole, 'owner'>
}

export interface InviteInput {
  /** `join` makes a new account (default); `reset` sets a new password for `forUserId`. */
  kind?: InviteKind
  role?: InstanceRole
  /** Fixes the username; otherwise the person chooses. */
  username?: string
  forUserId?: string
  /** Projects the new person is added to when they accept. The creator must be able to manage each. */
  grants?: InviteGrant[]
  maxProjects?: number | null
  ttlDays?: number
}

export interface InviteInfo {
  id: string
  kind: InviteKind
  role: InstanceRole
  username: string | null
  forUsername: string | null
  grants: { projectId: string; projectName: string; role: string }[]
  maxProjects: number | null
  createdBy: string | null
  createdAt: string
  expiresAt: string
  usedAt: string | null
  usedBy: string | null
  status: 'pending' | 'used' | 'expired' | 'revoked'
}

export class InviteError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'gone' | 'taken',
  ) {
    super(message)
    this.name = 'InviteError'
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const MAX_TTL_DAYS = 30

const RETURN = `i.id AS id, i.kind AS kind, i.role AS role, i.username AS username, i.forUsername AS forUsername,
  i.grantsJson AS grantsJson, i.maxProjects AS maxProjects, i.createdByName AS createdBy, toString(i.createdAt) AS createdAt,
  toString(i.expiresAt) AS expiresAt, toString(i.usedAt) AS usedAt, i.usedBy AS usedBy, toString(i.revokedAt) AS revokedAt,
  i.expiresAt < datetime() AS expired`

type Row = { get(key: string): unknown }

function toInfo(row: Row, names: Map<string, string>): InviteInfo {
  let grants: InviteGrant[] = []
  try {
    grants = JSON.parse((row.get('grantsJson') as string | null) ?? '[]') as InviteGrant[]
  } catch {
    // an unreadable grants list means no grants
  }
  const used = (row.get('usedAt') as string | null) ?? null
  const revoked = row.get('revokedAt') !== null && row.get('revokedAt') !== undefined
  return {
    id: row.get('id') as string,
    kind: row.get('kind') === 'reset' ? 'reset' : 'join',
    role: isInstanceRole(row.get('role')) ? (row.get('role') as InstanceRole) : 'member',
    username: (row.get('username') as string | null) ?? null,
    forUsername: (row.get('forUsername') as string | null) ?? null,
    grants: grants.map(g => ({ projectId: g.projectId, projectName: names.get(g.projectId) ?? g.projectId, role: g.role })),
    maxProjects: row.get('maxProjects') === null || row.get('maxProjects') === undefined ? null : Number(row.get('maxProjects')),
    createdBy: (row.get('createdBy') as string | null) ?? null,
    createdAt: row.get('createdAt') as string,
    expiresAt: row.get('expiresAt') as string,
    usedAt: used,
    usedBy: (row.get('usedBy') as string | null) ?? null,
    status: revoked ? 'revoked' : used ? 'used' : row.get('expired') === true ? 'expired' : 'pending',
  }
}

async function projectNames(brain: Brain, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const r = await brain.run('MATCH (p:Project) WHERE p.id IN $ids RETURN p.id AS id, coalesce(p.name, p.id) AS name', { ids })
  return new Map(r.records.map(x => [x.get('id') as string, x.get('name') as string]))
}

async function infos(brain: Brain, rows: readonly Row[]): Promise<InviteInfo[]> {
  const ids = new Set<string>()
  for (const row of rows) {
    try {
      for (const g of JSON.parse((row.get('grantsJson') as string | null) ?? '[]') as InviteGrant[]) ids.add(g.projectId)
    } catch {
      // ignored: shown without grants
    }
  }
  const names = await projectNames(brain, [...ids])
  return rows.map(row => toInfo(row, names))
}

/** Makes an invitation. The link secret is returned once; only its hash is stored. */
export async function createInvite(brain: Brain, creator: Principal, input: InviteInput = {}): Promise<{ info: InviteInfo; token: string }> {
  const kind: InviteKind = input.kind === 'reset' ? 'reset' : 'join'
  const role: InstanceRole = input.role ?? 'member'
  if (!isInstanceRole(role)) throw new InviteError('Unknown role.', 'invalid')
  const ttl = Math.min(Math.max(Math.trunc(input.ttlDays ?? 7), 1), MAX_TTL_DAYS)

  let username: string | null = null
  let forUser: UserRecord | null = null
  if (kind === 'reset') {
    forUser = input.forUserId ? await getUserById(brain, input.forUserId) : null
    if (!forUser) throw new InviteError('That account does not exist.', 'invalid')
  } else if (input.username?.trim()) {
    username = input.username.trim().toLowerCase()
    try {
      validateCredentials(username, 'placeholder-password')
    } catch (error) {
      throw new InviteError((error as Error).message, 'invalid')
    }
    const taken = await brain.run('MATCH (a) WHERE (a:User OR a:Admin) AND a.username = $username RETURN count(a) AS n', { username })
    if (Number(taken.records[0]?.get('n')) > 0) throw new InviteError('That username is taken.', 'taken')
  }

  const grants: InviteGrant[] = []
  for (const g of kind === 'join' ? (input.grants ?? []).slice(0, 50) : []) {
    const role: unknown = (g as { role?: unknown } | undefined)?.role
    if (!isProjectRole(role) || role === 'owner') throw new InviteError('A grant role must be viewer, editor or maintainer.', 'invalid')
    // you can only invite people into what you could add them to yourself
    await authorize(brain, creator, 'member.manage', g.projectId)
    grants.push({ projectId: g.projectId, role })
  }
  const maxProjects = input.maxProjects === undefined || input.maxProjects === null ? null : input.maxProjects
  if (maxProjects !== null && !(Number.isInteger(maxProjects) && maxProjects >= 0 && maxProjects <= 10_000)) {
    throw new InviteError('The project limit must be a whole number, or empty for no limit.', 'invalid')
  }

  const token = `inv_${randomBytes(32).toString('base64url')}`
  const r = await brain.run(
    `OPTIONAL MATCH (c) WHERE (c:User OR c:Admin) AND coalesce(c.id, c.username) = $creator
     CREATE (i:Invite {id: $id, hash: $hash, kind: $kind, role: $role, username: $username, forUserId: $forUserId,
                       forUsername: $forUsername, grantsJson: $grantsJson, maxProjects: $maxProjects,
                       createdByName: $createdByName, createdAt: datetime(), expiresAt: datetime() + duration({days: $ttl})})
     FOREACH (_ IN CASE WHEN c IS NULL THEN [] ELSE [1] END | CREATE (c)-[:CREATED]->(i))
     RETURN ${RETURN}`,
    {
      creator: creator.userId,
      id: randomUUID(),
      hash: sha256(token),
      kind,
      role: kind === 'reset' ? (forUser?.role ?? 'member') : role,
      username,
      forUserId: forUser?.id ?? null,
      forUsername: forUser?.username ?? null,
      grantsJson: JSON.stringify(grants),
      maxProjects,
      createdByName: creator.username,
      ttl,
    },
  )
  return { info: (await infos(brain, [r.records[0]!]))[0]!, token }
}

/** What the accept page shows for a link. Null for anything that does not work (unknown, used, expired, revoked). */
export async function previewInvite(brain: Brain, token: string): Promise<InviteInfo | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null
  const r = await brain.run(`MATCH (i:Invite {hash: $hash}) RETURN ${RETURN}`, { hash: sha256(token) })
  if (!r.records[0]) return null
  const info = (await infos(brain, [r.records[0]]))[0]!
  return info.status === 'pending' ? info : null
}

export async function listInvites(brain: Brain): Promise<InviteInfo[]> {
  const r = await brain.run(`MATCH (i:Invite) RETURN ${RETURN} ORDER BY i.createdAt DESC LIMIT 200`)
  return infos(brain, r.records)
}

/** Withdraws a link that has not been used. */
export async function revokeInvite(brain: Brain, id: string): Promise<boolean> {
  const r = await brain.run(
    'MATCH (i:Invite {id: $id}) WHERE i.usedAt IS NULL AND i.revokedAt IS NULL SET i.revokedAt = datetime() RETURN i.id AS id',
    { id },
  )
  return r.records.length > 0
}

/**
 * Redeems a link: creates the account (or sets the new password), adds it to the granted projects, and
 * spends the link, all in one transaction. Two people opening the same link cannot both succeed, and a
 * failure (a taken username, a weak password) leaves the link unspent.
 */
export async function acceptInvite(brain: Brain, token: string, input: { username?: string; password: string }): Promise<UserRecord> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw new InviteError('This invitation is not valid.', 'gone')
  const hash = sha256(token)
  const session = brain.session()
  try {
    return await session.executeWrite(async tx => {
      // separate statements on purpose: the first takes the write lock on the invitation, so the check
      // below is made only after any rival redemption has committed
      await tx.run('MATCH (i:Invite {hash: $hash}) SET i.attempts = coalesce(i.attempts, 0) + 1', { hash })
      const found = await tx.run(
        `MATCH (i:Invite {hash: $hash})
         WHERE i.usedAt IS NULL AND i.revokedAt IS NULL AND i.expiresAt > datetime()
         RETURN i.kind AS kind, i.role AS role, i.username AS fixed, i.forUserId AS forUserId, i.grantsJson AS grantsJson, i.maxProjects AS maxProjects`,
        { hash },
      )
      const row = found.records[0]
      if (!row) throw new InviteError('This invitation is no longer valid: it was used, withdrawn or has expired.', 'gone')

      let userId: string
      let username: string
      if (row.get('kind') === 'reset') {
        const existing = await tx.run(`MATCH (a) WHERE (a:User OR a:Admin) AND coalesce(a.id, a.username) = $id RETURN a.username AS username`, { id: row.get('forUserId') })
        if (!existing.records[0]) throw new InviteError('That account no longer exists.', 'gone')
        username = existing.records[0].get('username') as string
        userId = row.get('forUserId') as string
        try {
          validateCredentials(username, input.password)
        } catch (error) {
          throw new InviteError((error as Error).message, 'invalid')
        }
        await tx.run(`MATCH (a) WHERE (a:User OR a:Admin) AND coalesce(a.id, a.username) = $id SET a.passwordHash = $hash`, { id: userId, hash: await hashPassword(input.password) })
      } else {
        username = ((row.get('fixed') as string | null) ?? input.username ?? '').trim().toLowerCase()
        try {
          validateCredentials(username, input.password)
        } catch (error) {
          throw new InviteError((error as Error).message, 'invalid')
        }
        const taken = await tx.run('MATCH (a) WHERE (a:User OR a:Admin) AND a.username = $username RETURN count(a) AS n', { username })
        if (Number(taken.records[0]?.get('n')) > 0) throw new InviteError('That username is taken. Choose another.', 'taken')
        userId = randomUUID()
        const max = row.get('maxProjects')
        await tx.run(
          `CREATE (a:User {id: $id, username: $username, passwordHash: $hash, role: $role, status: 'active', createdAt: datetime(), maxProjects: $max})`,
          { id: userId, username, hash: await hashPassword(input.password), role: row.get('role'), max: max === null || max === undefined ? null : Number(max) },
        )
        for (const g of JSON.parse((row.get('grantsJson') as string | null) ?? '[]') as InviteGrant[]) {
          await tx.run(
            `MATCH (u:User {id: $userId}), (p:Project {id: $projectId})
             MERGE (u)-[m:MEMBER_OF]->(p) ON CREATE SET m.since = datetime()
             SET m.role = CASE WHEN m.role = 'owner' THEN 'owner' ELSE $role END`,
            { userId, projectId: g.projectId, role: g.role },
          )
        }
      }
      await tx.run('MATCH (i:Invite {hash: $hash}) SET i.usedAt = datetime(), i.usedBy = $username', { hash, username })
      const made = await tx.run(
        `MATCH (a) WHERE (a:User OR a:Admin) AND coalesce(a.id, a.username) = $id
         RETURN coalesce(a.id, a.username) AS id, a.username AS username, coalesce(a.role, 'admin') AS role, coalesce(a.status, 'active') AS status, toString(a.createdAt) AS createdAt, a.maxProjects AS maxProjects`,
        { id: userId },
      )
      const u = made.records[0]!
      return {
        id: u.get('id') as string,
        username: u.get('username') as string,
        role: isInstanceRole(u.get('role')) ? (u.get('role') as InstanceRole) : 'member',
        status: u.get('status') === 'disabled' ? 'disabled' : 'active',
        createdAt: u.get('createdAt') as string,
        maxProjects: u.get('maxProjects') === null || u.get('maxProjects') === undefined ? null : Number(u.get('maxProjects')),
      } satisfies UserRecord
    })
  } finally {
    await session.close()
  }
}

