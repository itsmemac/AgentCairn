import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { type InstanceRole, type Principal, type TokenScope, isInstanceRole } from './access.js'
import type { Brain } from './db.js'

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>

const SCRYPT = { N: 16384, r: 8, p: 1 }
const KEYLEN = 64

export class AdminError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'exists' | 'setup_closed',
  ) {
    super(message)
    this.name = 'AdminError'
  }
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/i

export function validateCredentials(username: string, password: string): void {
  if (!USERNAME.test(username)) {
    throw new AdminError('Username must be 3-32 characters: letters, digits, ".", "_" or "-".', 'invalid')
  }
  if (password.length < 10 || password.length > 200) {
    throw new AdminError('Password must be 10-200 characters.', 'invalid')
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt, KEYLEN, SCRYPT)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const key = await scryptAsync(password, Buffer.from(salt, 'hex'), KEYLEN, { N: Number(n), r: Number(r), p: Number(p) })
  const expected = Buffer.from(hash, 'hex')
  return key.length === expected.length && timingSafeEqual(key, expected)
}

// Verified against when the user does not exist, so timing does not reveal valid usernames.
const DUMMY = hashPassword('not-a-real-password')

// ---- users -----------------------------------------------------------------

/**
 * Accounts are `:User` nodes. Accounts made before users existed are `:Admin` nodes; the migration
 * adds the `:User` label to them and leaves `:Admin` in place so an older server image keeps working
 * during an upgrade. Until it has run, either label counts.
 */
const ACCOUNT = '(a) WHERE (a:User OR a:Admin)'

export interface UserRecord {
  id: string
  username: string
  role: InstanceRole
  status: 'active' | 'disabled'
  createdAt: string
  /** How many projects this person may own; null for no limit. */
  maxProjects: number | null
}

const USER_RETURN = `coalesce(a.id, a.username) AS id, a.username AS username, coalesce(a.role, 'admin') AS role,
  coalesce(a.status, 'active') AS status, toString(a.createdAt) AS createdAt, a.maxProjects AS maxProjects`

const toUser = (row: { get(k: string): unknown }): UserRecord => ({
  id: row.get('id') as string,
  username: row.get('username') as string,
  role: isInstanceRole(row.get('role')) ? (row.get('role') as InstanceRole) : 'member',
  status: row.get('status') === 'disabled' ? 'disabled' : 'active',
  createdAt: row.get('createdAt') as string,
  maxProjects: row.get('maxProjects') === null || row.get('maxProjects') === undefined ? null : Number(row.get('maxProjects')),
})

export const principalOf = (user: UserRecord, solo = false): Principal => ({ userId: user.id, username: user.username, role: user.role, solo })

export async function countAdmins(brain: Brain): Promise<number> {
  const r = await brain.run(`MATCH ${ACCOUNT} AND coalesce(a.role, 'admin') = 'admin' RETURN count(a) AS n`)
  return Number(r.records[0]?.get('n'))
}

export async function countUsers(brain: Brain): Promise<number> {
  const r = await brain.run(`MATCH ${ACCOUNT} RETURN count(a) AS n`)
  return Number(r.records[0]?.get('n'))
}

/** Active accounts. One means solo mode. */
export async function countActiveUsers(brain: Brain): Promise<number> {
  const r = await brain.run(`MATCH ${ACCOUNT} AND coalesce(a.status, 'active') = 'active' RETURN count(a) AS n`)
  return Number(r.records[0]?.get('n'))
}

export async function listUsers(brain: Brain): Promise<UserRecord[]> {
  const r = await brain.run(`MATCH ${ACCOUNT} RETURN ${USER_RETURN} ORDER BY a.createdAt, a.username`)
  return r.records.map(toUser)
}

export async function getUserByUsername(brain: Brain, username: string): Promise<UserRecord | null> {
  const r = await brain.run(`MATCH ${ACCOUNT} AND a.username = toLower($username) RETURN ${USER_RETURN}`, { username: username.slice(0, 64) })
  return r.records[0] ? toUser(r.records[0]) : null
}

export async function getUserById(brain: Brain, id: string): Promise<UserRecord | null> {
  const r = await brain.run(`MATCH ${ACCOUNT} AND coalesce(a.id, a.username) = $id RETURN ${USER_RETURN}`, { id })
  return r.records[0] ? toUser(r.records[0]) : null
}

/** The oldest admin: whoever the old shared environment token now acts as. */
export async function firstAdmin(brain: Brain): Promise<UserRecord | null> {
  const r = await brain.run(
    `MATCH ${ACCOUNT} AND coalesce(a.role, 'admin') = 'admin' AND coalesce(a.status, 'active') = 'active'
     RETURN ${USER_RETURN} ORDER BY a.createdAt LIMIT 1`,
  )
  return r.records[0] ? toUser(r.records[0]) : null
}

/**
 * Creates the first admin. Only works while there is none; the lock node
 * serializes two simultaneous setups so exactly one wins.
 */
export async function createFirstAdmin(brain: Brain, username: string, password: string): Promise<{ username: string; id: string }> {
  validateCredentials(username, password)
  const passwordHash = await hashPassword(password)
  const id = randomUUID()
  const session = brain.session()
  try {
    return await session.executeWrite(async tx => {
      // Separate statements on purpose: the first takes the write lock on the
      // lock node, so the count below is read only after any rival has committed.
      await tx.run(`MERGE (lock:BrainMeta {id: 'setup'}) SET lock.attempts = coalesce(lock.attempts, 0) + 1`)
      const existing = await tx.run('MATCH (a) WHERE (a:User OR a:Admin) RETURN count(a) AS n')
      if (Number(existing.records[0]?.get('n')) > 0) throw new AdminError('An admin account already exists.', 'setup_closed')
      const created = await tx.run(
        `CREATE (a:User:Admin {id: $id, username: toLower($username), passwordHash: $passwordHash, role: 'admin', status: 'active', createdAt: datetime()})
         RETURN a.username AS username, a.id AS id`,
        { id, username, passwordHash },
      )
      return { username: created.records[0]!.get('username') as string, id: created.records[0]!.get('id') as string }
    })
  } finally {
    await session.close()
  }
}

/** Adds an account. Usernames are unique, whatever their case. */
export async function createUser(brain: Brain, input: { username: string; password: string; role?: InstanceRole }): Promise<UserRecord> {
  validateCredentials(input.username, input.password)
  const role = input.role ?? 'member'
  if (!isInstanceRole(role)) throw new AdminError('Unknown role.', 'invalid')
  const passwordHash = await hashPassword(input.password)
  const session = brain.session()
  try {
    return await session.executeWrite(async tx => {
      const taken = await tx.run('MATCH (a) WHERE (a:User OR a:Admin) AND a.username = toLower($username) RETURN count(a) AS n', { username: input.username })
      if (Number(taken.records[0]?.get('n')) > 0) throw new AdminError('That username is taken.', 'exists')
      const made = await tx.run(
        `CREATE (a:User {id: $id, username: toLower($username), passwordHash: $passwordHash, role: $role, status: 'active', createdAt: datetime()})
         RETURN ${USER_RETURN}`,
        { id: randomUUID(), username: input.username, passwordHash, role },
      )
      return toUser(made.records[0]!)
    })
  } finally {
    await session.close()
  }
}

/**
 * Recovery for a lost admin login: removes admin accounts (all of them, or only `usernames`) and
 * revokes the tokens they created. Projects they owned have no owner afterwards and are adopted by the
 * next admin (the migration does that at the next startup, or when the new admin is created).
 * Members are untouched. Returns how many accounts were removed.
 */
export async function resetAdmins(brain: Brain, options: { usernames?: string[] } = {}): Promise<number> {
  const names = options.usernames?.map(n => n.toLowerCase()) ?? null
  const found = await brain.run(
    `MATCH ${ACCOUNT} AND coalesce(a.role, 'admin') = 'admin' AND ($names IS NULL OR a.username IN $names)
     RETURN collect(a.username) AS names`,
    { names },
  )
  const admins = (found.records[0]?.get('names') as string[] | undefined) ?? []
  if (admins.length === 0) return 0
  await brain.run('MATCH (t:ApiToken) WHERE t.createdBy IN $admins AND t.revokedAt IS NULL SET t.revokedAt = datetime()', { admins })
  await brain.run(`MATCH ${ACCOUNT} AND a.username IN $admins DETACH DELETE a`, { admins })
  return admins.length
}

/** Disables or re-enables an account. The last active admin cannot be disabled. */
export async function setUserStatus(brain: Brain, id: string, status: 'active' | 'disabled'): Promise<boolean> {
  if (status === 'disabled') {
    const user = await getUserById(brain, id)
    if (user?.role === 'admin' && (await countActiveAdmins(brain)) <= 1) {
      throw new AdminError('The last active admin cannot be disabled.', 'invalid')
    }
  }
  const r = await brain.run(`MATCH ${ACCOUNT} AND coalesce(a.id, a.username) = $id SET a.status = $status RETURN a.username AS u`, { id, status })
  return r.records.length > 0
}

async function countActiveAdmins(brain: Brain): Promise<number> {
  const r = await brain.run(`MATCH ${ACCOUNT} AND coalesce(a.role, 'admin') = 'admin' AND coalesce(a.status, 'active') = 'active' RETURN count(a) AS n`)
  return Number(r.records[0]?.get('n'))
}

/** Checks a password. Disabled accounts cannot sign in. */
export async function verifyAdmin(brain: Brain, username: string, password: string): Promise<UserRecord | null> {
  const r = await brain.run(`MATCH ${ACCOUNT} AND a.username = toLower($username) RETURN ${USER_RETURN}, a.passwordHash AS hash`, {
    username: username.slice(0, 64),
  })
  const row = r.records[0]
  const ok = await checkPassword(password.slice(0, 200), row ? (row.get('hash') as string) : await DUMMY)
  if (!row || !ok) return null
  const user = toUser(row)
  return user.status === 'active' ? user : null
}

export const verifyUser = verifyAdmin

export async function changeAdminPassword(brain: Brain, username: string, current: string, next: string): Promise<boolean> {
  validateCredentials(username, next)
  if (!(await verifyAdmin(brain, username, current))) return false
  await brain.run(`MATCH ${ACCOUNT} AND a.username = toLower($username) SET a.passwordHash = $hash`, {
    username,
    hash: await hashPassword(next),
  })
  return true
}

// ---- API tokens ------------------------------------------------------------

export interface ApiTokenInfo {
  id: string
  name: string
  /** First characters of the token, to recognize it in a list. */
  prefix: string
  createdAt: string
  createdBy: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  /** The token can read but never write. */
  readOnly: boolean
  /** The token only reaches these projects; empty means every project its user can reach. */
  projects: string[]
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const TOKEN_RETURN = `t.id AS id, t.name AS name, t.prefix AS prefix, toString(t.createdAt) AS createdAt,
  t.createdBy AS createdBy, toString(t.lastUsedAt) AS lastUsedAt, toString(t.revokedAt) AS revokedAt,
  coalesce(t.readOnly, false) AS readOnly, coalesce(t.projects, []) AS projects`

const toInfo = (row: { get(k: string): unknown }): ApiTokenInfo => ({
  id: row.get('id') as string,
  name: row.get('name') as string,
  prefix: row.get('prefix') as string,
  createdAt: row.get('createdAt') as string,
  createdBy: (row.get('createdBy') as string | null) ?? null,
  lastUsedAt: (row.get('lastUsedAt') as string | null) ?? null,
  revokedAt: (row.get('revokedAt') as string | null) ?? null,
  readOnly: row.get('readOnly') === true,
  projects: (row.get('projects') as string[] | undefined) ?? [],
})

/** Creates a token. The plaintext is returned once; only its hash is stored. The token acts as its creator. */
export async function createApiToken(
  brain: Brain,
  name: string,
  createdBy?: string,
  scope: { readOnly?: boolean; projects?: string[] } = {},
): Promise<{ info: ApiTokenInfo; token: string }> {
  const label = name.trim()
  if (!label || label.length > 60) throw new AdminError('Token name must be 1-60 characters.', 'invalid')
  const token = `aib_${randomBytes(24).toString('base64url')}`
  const r = await brain.run(
    `OPTIONAL MATCH (a) WHERE (a:User OR a:Admin) AND a.username = toLower($createdBy)
     CREATE (t:ApiToken {id: $id, name: $name, hash: $hash, prefix: $prefix, createdAt: datetime(), createdBy: $createdBy, readOnly: $readOnly, projects: $projects})
     FOREACH (_ IN CASE WHEN a IS NULL THEN [] ELSE [1] END | CREATE (a)-[:CREATED]->(t))
     RETURN ${TOKEN_RETURN}`,
    {
      id: randomBytes(8).toString('hex'),
      name: label,
      hash: sha256(token),
      prefix: token.slice(0, 8),
      createdBy: createdBy ?? null,
      readOnly: scope.readOnly === true,
      projects: [...new Set((scope.projects ?? []).filter(p => typeof p === 'string' && p !== '').slice(0, 100))],
    },
  )
  return { info: toInfo(r.records[0]!), token }
}

/** Tokens created by one user (or all of them, for an admin). */
export async function listApiTokens(brain: Brain, options: { createdBy?: string } = {}): Promise<ApiTokenInfo[]> {
  const r = await brain.run(
    `MATCH (t:ApiToken) WHERE $createdBy IS NULL OR t.createdBy = toLower($createdBy)
     RETURN ${TOKEN_RETURN} ORDER BY t.createdAt DESC`,
    { createdBy: options.createdBy ?? null },
  )
  return r.records.map(toInfo)
}

export async function revokeApiToken(brain: Brain, id: string, options: { createdBy?: string } = {}): Promise<boolean> {
  const r = await brain.run(
    `MATCH (t:ApiToken {id: $id}) WHERE t.revokedAt IS NULL AND ($createdBy IS NULL OR t.createdBy = toLower($createdBy))
     SET t.revokedAt = datetime() RETURN t.id AS id`,
    { id, createdBy: options.createdBy ?? null },
  )
  return r.records.length > 0
}

export interface FoundToken {
  id: string
  name: string
  /** The account the token acts as; null for a token with no creator (treated as the first admin). */
  user: UserRecord | null
  /** What the token is limited to, or null when it can do all its user can. */
  scope: TokenScope | null
}

/** Looks a presented token up by hash; revoked tokens do not match. */
export async function findApiToken(brain: Brain, token: string): Promise<FoundToken | null> {
  const r = await brain.run(
    `MATCH (t:ApiToken {hash: $hash}) WHERE t.revokedAt IS NULL
     OPTIONAL MATCH (a)-[:CREATED]->(t) WHERE a:User OR a:Admin
     RETURN t.id AS tokenId, t.name AS tokenName, coalesce(t.readOnly, false) AS readOnly, coalesce(t.projects, []) AS scopedProjects, ${USER_RETURN}`,
    { hash: sha256(token) },
  )
  const row = r.records[0]
  if (!row) return null
  const readOnly = row.get('readOnly') === true
  const projects = row.get('scopedProjects') as string[]
  return {
    id: row.get('tokenId') as string,
    name: row.get('tokenName') as string,
    user: row.get('username') ? toUser(row) : null,
    scope: readOnly || projects.length ? { readOnly, projects: projects.length ? projects : null } : null,
  }
}

export async function touchApiToken(brain: Brain, id: string): Promise<void> {
  await brain.run('MATCH (t:ApiToken {id: $id}) SET t.lastUsedAt = datetime()', { id })
}

export async function countActiveTokens(brain: Brain): Promise<number> {
  const r = await brain.run('MATCH (t:ApiToken) WHERE t.revokedAt IS NULL RETURN count(t) AS n')
  return Number(r.records[0]?.get('n'))
}

// ---- managing accounts ---------------------------------------------------------

export interface UserOverview extends UserRecord {
  /** Projects this person owns. */
  owned: number
  /** Projects this person can reach, owned or shared. */
  reach: number
}

export async function listUserOverview(brain: Brain): Promise<UserOverview[]> {
  const r = await brain.run(
    `MATCH ${ACCOUNT}
     OPTIONAL MATCH (a)-[m:MEMBER_OF]->(:Project)
     RETURN ${USER_RETURN}, count(m) AS reach, count(CASE WHEN m.role = 'owner' THEN 1 END) AS owned
     ORDER BY createdAt, username`,
  )
  return r.records.map(row => ({ ...toUser(row), reach: Number(row.get('reach')), owned: Number(row.get('owned')) }))
}

async function guardLastAdmin(brain: Brain, id: string, what: string): Promise<void> {
  const user = await getUserById(brain, id)
  if (user?.role === 'admin' && user.status === 'active' && (await countActiveAdmins(brain)) <= 1) {
    throw new AdminError(`The last active admin cannot be ${what}.`, 'invalid')
  }
}

/** Promotes or demotes an account. The last active admin cannot be demoted. */
export async function setUserRole(brain: Brain, id: string, role: InstanceRole): Promise<boolean> {
  if (!isInstanceRole(role)) throw new AdminError('Unknown role.', 'invalid')
  if (role !== 'admin') await guardLastAdmin(brain, id, 'demoted')
  const r = await brain.run(`MATCH ${ACCOUNT} AND coalesce(a.id, a.username) = $id SET a.role = $role RETURN a.username AS u`, { id, role })
  return r.records.length > 0
}

/** Caps how many projects an account may own (null removes the cap). */
export async function setUserLimits(brain: Brain, id: string, limits: { maxProjects: number | null }): Promise<boolean> {
  const max = limits.maxProjects
  if (max !== null && !(Number.isInteger(max) && max >= 0 && max <= 10_000)) {
    throw new AdminError('The project limit must be a whole number from 0 to 10000, or empty for no limit.', 'invalid')
  }
  const r = await brain.run(`MATCH ${ACCOUNT} AND coalesce(a.id, a.username) = $id SET a.maxProjects = $max RETURN a.username AS u`, { id, max })
  return r.records.length > 0
}

/** Sets a new password directly (used when someone follows a password-reset link). */
export async function setUserPassword(brain: Brain, id: string, username: string, password: string): Promise<void> {
  validateCredentials(username, password)
  await brain.run(`MATCH ${ACCOUNT} AND coalesce(a.id, a.username) = $id SET a.passwordHash = $hash`, { id, hash: await hashPassword(password) })
}

/**
 * Removes an account, its memberships and the tokens it made. Someone who still owns projects cannot be
 * removed: their projects would be left with no owner, so they must be transferred or deleted first.
 */
export async function removeUser(brain: Brain, id: string): Promise<boolean> {
  const user = await getUserById(brain, id)
  if (!user) return false
  await guardLastAdmin(brain, id, 'removed')
  const owned = await brain.run(
    `MATCH ${ACCOUNT} AND coalesce(a.id, a.username) = $id
     MATCH (a)-[:MEMBER_OF {role: 'owner'}]->(p:Project)
     RETURN coalesce(p.name, p.id) AS name ORDER BY name LIMIT 10`,
    { id },
  )
  if (owned.records.length) {
    throw new AdminError(`${user.username} still owns ${owned.records.map(r => `"${r.get('name')}"`).join(', ')}. Transfer or delete those projects first.`, 'invalid')
  }
  await brain.run('MATCH (t:ApiToken) WHERE t.createdBy = $username AND t.revokedAt IS NULL SET t.revokedAt = datetime()', { username: user.username })
  await brain.run(`MATCH ${ACCOUNT} AND coalesce(a.id, a.username) = $id DETACH DELETE a`, { id })
  return true
}
