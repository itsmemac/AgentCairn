import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AdminError,
  type Brain,
  changeAdminPassword,
  countActiveTokens,
  countAdmins,
  createApiToken,
  createFirstAdmin,
  ensureSchema,
  findApiToken,
  listApiTokens,
  loadConfig,
  openBrain,
  revokeApiToken,
  tidySystemNodes,
  touchApiToken,
  verifyAdmin,
} from '../src/index.js'

// Admin accounts are global to the database, so the account tests only run
// while no admin exists (a fresh CI database), and remove what they create.
const hasDb = Boolean(process.env.NEO4J_URI)
const adminSlotFree = hasDb
  ? await (async () => {
      const b = openBrain(loadConfig())
      try {
        await ensureSchema(b)
        return (await countAdmins(b)) === 0
      } finally {
        await b.close()
      }
    })()
  : false

describe.skipIf(!adminSlotFree)('admin accounts', () => {
  const run = randomBytes(3).toString('hex')
  const alice = `alice-${run}`
  const password = 'correct horse battery'
  let brain: Brain

  beforeAll(async () => {
    brain = openBrain(loadConfig())
  })
  afterAll(async () => {
    await brain.run('MATCH (t:ApiToken) WHERE t.name STARTS WITH $p DETACH DELETE t', { p: `t-${run}` })
    await brain.run('MATCH (a:Admin) DETACH DELETE a')
    await brain.run("MATCH (m:BrainMeta {id: 'setup'}) DELETE m")
    await brain.close()
  })

  it('validates credentials', async () => {
    await expect(createFirstAdmin(brain, 'x', password)).rejects.toBeInstanceOf(AdminError)
    await expect(createFirstAdmin(brain, alice, 'short')).rejects.toBeInstanceOf(AdminError)
    await expect(createFirstAdmin(brain, 'bad name!', password)).rejects.toBeInstanceOf(AdminError)
    expect(await countAdmins(brain)).toBe(0)
  })

  it('simultaneous setups: exactly one wins', async () => {
    const results = await Promise.allSettled([
      createFirstAdmin(brain, alice, password),
      createFirstAdmin(brain, `bob-${run}`, password),
      createFirstAdmin(brain, `carol-${run}`, password),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(await countAdmins(brain)).toBe(1)
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult
    expect((rejected.reason as AdminError).code).toBe('setup_closed')
  })

  it('setup is closed once an admin exists', async () => {
    await expect(createFirstAdmin(brain, `dave-${run}`, password)).rejects.toMatchObject({ code: 'setup_closed' })
  })

  it('verifies the password, case-insensitively on the username, and never stores it', async () => {
    const winner = (await brain.run('MATCH (a:Admin) RETURN a.username AS u, a.passwordHash AS h')).records[0]!
    const username = winner.get('u') as string
    expect(winner.get('h')).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/)
    expect(winner.get('h')).not.toContain(password)

    expect(await verifyAdmin(brain, username, password)).toEqual({ username })
    expect(await verifyAdmin(brain, username.toUpperCase(), password)).toEqual({ username })
    expect(await verifyAdmin(brain, username, `${password}x`)).toBeNull()
    expect(await verifyAdmin(brain, 'nobody-here', password)).toBeNull()
  })

  it('leaves no stray bookkeeping: the setup lock is tidied away and tokens hang off their admin', async () => {
    const username = (await brain.run('MATCH (a:Admin) RETURN a.username AS u')).records[0]!.get('u') as string
    const lockCount = async () => Number((await brain.run("MATCH (l:BrainMeta {id: 'setup'}) RETURN count(l) AS n")).records[0]!.get('n'))
    expect(await lockCount()).toBe(1) // the setup left its lock behind
    await tidySystemNodes(brain)
    expect(await lockCount()).toBe(0)

    const { info } = await createApiToken(brain, `t-${run}-linked`, username)
    const linked = () => brain.run('MATCH (:Admin {username: $u})-[:CREATED]->(t:ApiToken {id: $id}) RETURN count(t) AS n', { u: username, id: info.id })
    expect(Number((await linked()).records[0]!.get('n'))).toBe(1)

    // a token that predates the link (or a lock left by an older version) is repaired by the tidy-up
    await brain.run('MATCH ()-[r:CREATED]->(t:ApiToken {id: $id}) DELETE r', { id: info.id })
    await brain.run("MERGE (:BrainMeta {id: 'setup'})")
    await tidySystemNodes(brain)
    expect(Number((await linked()).records[0]!.get('n'))).toBe(1)
    expect(await lockCount()).toBe(0)
  })

  it('changes the password only with the current one', async () => {
    const username = (await brain.run('MATCH (a:Admin) RETURN a.username AS u')).records[0]!.get('u') as string
    expect(await changeAdminPassword(brain, username, 'wrong password!!', 'a brand new password')).toBe(false)
    expect(await changeAdminPassword(brain, username, password, 'a brand new password')).toBe(true)
    expect(await verifyAdmin(brain, username, password)).toBeNull()
    expect(await verifyAdmin(brain, username, 'a brand new password')).not.toBeNull()
  })
})

describe.skipIf(!hasDb)('API tokens', () => {
  const run = randomBytes(3).toString('hex')
  let brain: Brain

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    await ensureSchema(brain)
  })
  afterAll(async () => {
    await brain.run('MATCH (t:ApiToken) WHERE t.name STARTS WITH $p DETACH DELETE t', { p: `t-${run}` })
    await brain.close()
  })

  it('creates a token whose plaintext is shown once and only its hash is stored', async () => {
    const before = await countActiveTokens(brain)
    const { info, token } = await createApiToken(brain, `t-${run}-laptop`, 'admin')
    expect(token).toMatch(/^aib_[A-Za-z0-9_-]{32}$/)
    expect(info).toMatchObject({ name: `t-${run}-laptop`, prefix: token.slice(0, 8), createdBy: 'admin', lastUsedAt: null, revokedAt: null })
    expect(await countActiveTokens(brain)).toBe(before + 1)

    const raw = (await brain.run('MATCH (t:ApiToken {id: $id}) RETURN properties(t) AS p', { id: info.id })).records[0]!.get('p') as Record<string, unknown>
    expect(JSON.stringify(raw)).not.toContain(token)
    expect(raw.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('finds only live tokens and records use', async () => {
    const { info, token } = await createApiToken(brain, `t-${run}-ci`)
    expect(await findApiToken(brain, token)).toEqual({ id: info.id, name: `t-${run}-ci`, user: null })
    expect(await findApiToken(brain, `${token}x`)).toBeNull()
    expect(await findApiToken(brain, '')).toBeNull()

    await touchApiToken(brain, info.id)
    expect((await listApiTokens(brain)).find(t => t.id === info.id)?.lastUsedAt).not.toBeNull()

    expect(await revokeApiToken(brain, info.id)).toBe(true)
    expect(await revokeApiToken(brain, info.id)).toBe(false)
    expect(await findApiToken(brain, token)).toBeNull()
    expect((await listApiTokens(brain)).find(t => t.id === info.id)?.revokedAt).not.toBeNull()
  })

  it('validates names', async () => {
    await expect(createApiToken(brain, '  ')).rejects.toBeInstanceOf(AdminError)
    await expect(createApiToken(brain, 'x'.repeat(61))).rejects.toBeInstanceOf(AdminError)
  })
})
