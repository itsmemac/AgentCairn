import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
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

async function hashPassword(password: string): Promise<string> {
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

export async function countAdmins(brain: Brain): Promise<number> {
  const r = await brain.run('MATCH (a:Admin) RETURN count(a) AS n')
  return Number(r.records[0]?.get('n'))
}

/**
 * Creates the first admin. Only works while there is none; the lock node
 * serializes two simultaneous setups so exactly one wins.
 */
export async function createFirstAdmin(brain: Brain, username: string, password: string): Promise<{ username: string }> {
  validateCredentials(username, password)
  const passwordHash = await hashPassword(password)
  const session = brain.session()
  try {
    return await session.executeWrite(async tx => {
      // Separate statements on purpose: the first takes the write lock on the
      // lock node, so the count below is read only after any rival has committed.
      await tx.run(`MERGE (lock:BrainMeta {id: 'setup'}) SET lock.attempts = coalesce(lock.attempts, 0) + 1`)
      const existing = await tx.run('MATCH (a:Admin) RETURN count(a) AS n')
      if (Number(existing.records[0]?.get('n')) > 0) throw new AdminError('An admin account already exists.', 'setup_closed')
      const created = await tx.run(
        `CREATE (a:Admin {username: toLower($username), passwordHash: $passwordHash, createdAt: datetime()})
         RETURN a.username AS username`,
        { username, passwordHash },
      )
      return { username: created.records[0]!.get('username') as string }
    })
  } finally {
    await session.close()
  }
}

export async function verifyAdmin(brain: Brain, username: string, password: string): Promise<{ username: string } | null> {
  const r = await brain.run('MATCH (a:Admin {username: toLower($username)}) RETURN a.username AS username, a.passwordHash AS hash', {
    username: username.slice(0, 64),
  })
  const row = r.records[0]
  const ok = await checkPassword(password.slice(0, 200), row ? (row.get('hash') as string) : await DUMMY)
  return row && ok ? { username: row.get('username') as string } : null
}

export async function changeAdminPassword(brain: Brain, username: string, current: string, next: string): Promise<boolean> {
  validateCredentials(username, next)
  if (!(await verifyAdmin(brain, username, current))) return false
  await brain.run('MATCH (a:Admin {username: toLower($username)}) SET a.passwordHash = $hash', {
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
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const TOKEN_RETURN = `t.id AS id, t.name AS name, t.prefix AS prefix, toString(t.createdAt) AS createdAt,
  t.createdBy AS createdBy, toString(t.lastUsedAt) AS lastUsedAt, toString(t.revokedAt) AS revokedAt`

const toInfo = (row: { get(k: string): unknown }): ApiTokenInfo => ({
  id: row.get('id') as string,
  name: row.get('name') as string,
  prefix: row.get('prefix') as string,
  createdAt: row.get('createdAt') as string,
  createdBy: (row.get('createdBy') as string | null) ?? null,
  lastUsedAt: (row.get('lastUsedAt') as string | null) ?? null,
  revokedAt: (row.get('revokedAt') as string | null) ?? null,
})

/** Creates a token. The plaintext is returned once; only its hash is stored. */
export async function createApiToken(brain: Brain, name: string, createdBy?: string): Promise<{ info: ApiTokenInfo; token: string }> {
  const label = name.trim()
  if (!label || label.length > 60) throw new AdminError('Token name must be 1-60 characters.', 'invalid')
  const token = `aib_${randomBytes(24).toString('base64url')}`
  const r = await brain.run(
    `OPTIONAL MATCH (a:Admin {username: toLower($createdBy)})
     CREATE (t:ApiToken {id: $id, name: $name, hash: $hash, prefix: $prefix, createdAt: datetime(), createdBy: $createdBy})
     FOREACH (_ IN CASE WHEN a IS NULL THEN [] ELSE [1] END | CREATE (a)-[:CREATED]->(t))
     RETURN ${TOKEN_RETURN}`,
    { id: randomBytes(8).toString('hex'), name: label, hash: sha256(token), prefix: token.slice(0, 8), createdBy: createdBy ?? null },
  )
  return { info: toInfo(r.records[0]!), token }
}

export async function listApiTokens(brain: Brain): Promise<ApiTokenInfo[]> {
  const r = await brain.run(`MATCH (t:ApiToken) RETURN ${TOKEN_RETURN} ORDER BY t.createdAt DESC`)
  return r.records.map(toInfo)
}

export async function revokeApiToken(brain: Brain, id: string): Promise<boolean> {
  const r = await brain.run(
    `MATCH (t:ApiToken {id: $id}) WHERE t.revokedAt IS NULL SET t.revokedAt = datetime() RETURN t.id AS id`,
    { id },
  )
  return r.records.length > 0
}

/** Looks a presented token up by hash; revoked tokens do not match. */
export async function findApiToken(brain: Brain, token: string): Promise<{ id: string; name: string } | null> {
  const r = await brain.run(
    'MATCH (t:ApiToken {hash: $hash}) WHERE t.revokedAt IS NULL RETURN t.id AS id, t.name AS name',
    { hash: sha256(token) },
  )
  const row = r.records[0]
  return row ? { id: row.get('id') as string, name: row.get('name') as string } : null
}

export async function touchApiToken(brain: Brain, id: string): Promise<void> {
  await brain.run('MATCH (t:ApiToken {id: $id}) SET t.lastUsedAt = datetime()', { id })
}

export async function countActiveTokens(brain: Brain): Promise<number> {
  const r = await brain.run('MATCH (t:ApiToken) WHERE t.revokedAt IS NULL RETURN count(t) AS n')
  return Number(r.records[0]?.get('n'))
}
