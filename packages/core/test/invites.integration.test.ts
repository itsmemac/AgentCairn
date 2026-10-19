import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AccessError,
  type Brain,
  InviteError,
  type Principal,
  ProjectNameError,
  acceptInvite,
  accessibleProjectIds,
  authorize,
  createApiToken,
  createInvite,
  createProject,
  createUser,
  deleteProject,
  ensureSchema,
  findAccessibleProject,
  findApiToken,
  getUserById,
  listAudit,
  listInvites,
  listUserOverview,
  loadConfig,
  openBrain,
  previewInvite,
  principalOf,
  projectRole,
  recordAudit,
  registerProject,
  removeUser,
  revokeApiToken,
  revokeInvite,
  setMembership,
  setUserLimits,
  setUserRole,
  verifyUser,
} from '../src/index.js'

describe.skipIf(!process.env.NEO4J_URI)('invitations, accounts, token scopes and the audit log against a live Neo4j', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const name = (n: string) => `${run}-${n}`
  const password = 'correct horse battery'
  let brain: Brain
  let admin: Principal
  const projects: string[] = []

  const project = async (owner: Principal, n: string) => {
    const p = await createProject(brain, owner.userId, name(n))
    projects.push(p.id)
    return p
  }

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    await ensureSchema(brain)
    admin = principalOf(await createUser(brain, { username: name('admin'), password, role: 'admin' }))
  })

  afterAll(async () => {
    for (const id of projects.filter(Boolean)) await deleteProject(brain, id).catch(() => undefined)
    await brain.run('MATCH (i:Invite) WHERE i.createdByName STARTS WITH $run DETACH DELETE i', { run })
    await brain.run('MATCH (t:ApiToken) WHERE t.createdBy STARTS WITH $run DETACH DELETE t', { run })
    await brain.run('MATCH (a:Audit) WHERE a.actor STARTS WITH $run DETACH DELETE a', { run })
    await brain.run('MATCH (u:User) WHERE u.username STARTS WITH $run DETACH DELETE u', { run })
    await brain.close()
  })

  describe('invitations', () => {
    it('a link makes an account once, and only the hash of it is stored', async () => {
      const { info, token } = await createInvite(brain, admin, { role: 'member' })
      expect(token).toMatch(/^inv_[A-Za-z0-9_-]{40,}$/)
      expect(info).toMatchObject({ kind: 'join', role: 'member', status: 'pending', createdBy: admin.username, usedAt: null })
      const stored = await brain.run('MATCH (i:Invite {id: $id}) RETURN properties(i) AS p', { id: info.id })
      expect(JSON.stringify(stored.records[0]!.get('p'))).not.toContain(token)

      expect(await previewInvite(brain, token)).toMatchObject({ id: info.id, role: 'member', username: null })
      const user = await acceptInvite(brain, token, { username: name('newbie'), password })
      expect(user).toMatchObject({ username: name('newbie'), role: 'member', status: 'active' })
      expect(await verifyUser(brain, name('newbie'), password)).toMatchObject({ id: user.id })

      expect(await previewInvite(brain, token)).toBeNull()
      await expect(acceptInvite(brain, token, { username: name('again'), password })).rejects.toMatchObject({ code: 'gone' })
      expect((await listInvites(brain)).find(i => i.id === info.id)).toMatchObject({ status: 'used', usedBy: name('newbie') })
    })

    it('two people opening one link cannot both get an account', async () => {
      const { token } = await createInvite(brain, admin, {})
      const results = await Promise.allSettled([
        acceptInvite(brain, token, { username: name('racer1'), password }),
        acceptInvite(brain, token, { username: name('racer2'), password }),
        acceptInvite(brain, token, { username: name('racer3'), password }),
      ])
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
      const made = await brain.run('MATCH (u:User) WHERE u.username STARTS WITH $p RETURN count(u) AS n', { p: name('racer') })
      expect(Number(made.records[0]?.get('n'))).toBe(1)
    })

    it('a failed attempt (weak password, taken name) does not spend the link', async () => {
      const { token } = await createInvite(brain, admin, {})
      await expect(acceptInvite(brain, token, { username: name('weak'), password: 'short' })).rejects.toMatchObject({ code: 'invalid' })
      await expect(acceptInvite(brain, token, { username: name('admin'), password })).rejects.toMatchObject({ code: 'taken' })
      await expect(acceptInvite(brain, token, { username: '!!', password })).rejects.toBeInstanceOf(InviteError)
      expect(await previewInvite(brain, token)).not.toBeNull()
      expect(await acceptInvite(brain, token, { username: name('patient'), password })).toMatchObject({ username: name('patient') })
    })

    it('expired, revoked and unknown links do not work', async () => {
      const expired = await createInvite(brain, admin, {})
      await brain.run('MATCH (i:Invite {id: $id}) SET i.expiresAt = datetime() - duration({hours: 1})', { id: expired.info.id })
      expect(await previewInvite(brain, expired.token)).toBeNull()
      await expect(acceptInvite(brain, expired.token, { username: name('late'), password })).rejects.toMatchObject({ code: 'gone' })
      expect((await listInvites(brain)).find(i => i.id === expired.info.id)?.status).toBe('expired')

      const revoked = await createInvite(brain, admin, {})
      expect(await revokeInvite(brain, revoked.info.id)).toBe(true)
      expect(await revokeInvite(brain, revoked.info.id)).toBe(false)
      expect(await previewInvite(brain, revoked.token)).toBeNull()
      await expect(acceptInvite(brain, revoked.token, { username: name('nope'), password })).rejects.toMatchObject({ code: 'gone' })

      expect(await previewInvite(brain, 'inv_' + 'x'.repeat(43))).toBeNull()
      await expect(acceptInvite(brain, 'nonsense', { username: name('x'), password })).rejects.toMatchObject({ code: 'gone' })
    })

    it('can fix the username, and refuses one that is already taken', async () => {
      const { info, token } = await createInvite(brain, admin, { username: name('Fixed') })
      expect(info.username).toBe(name('fixed'))
      expect(await acceptInvite(brain, token, { username: 'ignored-choice', password })).toMatchObject({ username: name('fixed') })
      await expect(createInvite(brain, admin, { username: name('fixed') })).rejects.toMatchObject({ code: 'taken' })
    })

    it('adds the new person to the projects named in the link, and only ones the inviter can manage', async () => {
      const mine = await project(admin, 'shared-on-join')
      const { token } = await createInvite(brain, admin, { grants: [{ projectId: mine.id, role: 'editor' }], maxProjects: 2 })
      const user = await acceptInvite(brain, token, { username: name('guest'), password })
      expect(await projectRole(brain, user.id, mine.id)).toBe('editor')
      expect(user.maxProjects).toBe(2)

      const other = principalOf(await createUser(brain, { username: name('other'), password }))
      const theirs = await project(other, 'not-admins')
      await expect(createInvite(brain, admin, { grants: [{ projectId: theirs.id, role: 'viewer' }] })).rejects.toBeInstanceOf(AccessError)
      await expect(createInvite(brain, admin, { grants: [{ projectId: mine.id, role: 'owner' as never }] })).rejects.toMatchObject({ code: 'invalid' })
    })

    it('a reset link gives an existing account a new password and nothing else', async () => {
      const u = await createUser(brain, { username: name('forgetful'), password })
      const { info, token } = await createInvite(brain, admin, { kind: 'reset', forUserId: u.id })
      expect(info).toMatchObject({ kind: 'reset', forUsername: u.username })
      await expect(acceptInvite(brain, token, { password: 'tooshort' })).rejects.toMatchObject({ code: 'invalid' })
      const back = await acceptInvite(brain, token, { password: 'a brand new passphrase' })
      expect(back.id).toBe(u.id)
      expect(await verifyUser(brain, u.username, password)).toBeNull()
      expect(await verifyUser(brain, u.username, 'a brand new passphrase')).toMatchObject({ id: u.id })
      await expect(createInvite(brain, admin, { kind: 'reset', forUserId: 'nobody' })).rejects.toMatchObject({ code: 'invalid' })
    })
  })

  describe('accounts and limits', () => {
    it('a project limit stops the next one, and removing the limit lifts it', async () => {
      const u = await createUser(brain, { username: name('limited'), password })
      expect(await setUserLimits(brain, u.id, { maxProjects: 1 })).toBe(true)
      const first = await createProject(brain, u.id, name('one'))
      projects.push(first.id)
      await expect(createProject(brain, u.id, name('two'))).rejects.toMatchObject({ code: 'limit' })
      await expect(createProject(brain, u.id, name('two'))).rejects.toBeInstanceOf(ProjectNameError)
      await setUserLimits(brain, u.id, { maxProjects: null })
      projects.push((await createProject(brain, u.id, name('two'))).id)
      await expect(setUserLimits(brain, u.id, { maxProjects: -1 })).rejects.toMatchObject({ code: 'invalid' })
      expect((await getUserById(brain, u.id))?.maxProjects).toBeNull()
    })

    it('the overview counts what each person owns and can reach', async () => {
      const u = await createUser(brain, { username: name('counted'), password })
      const own = await createProject(brain, u.id, name('owned-by-counted'))
      const sharedIn = await project(admin, 'shared-with-counted')
      projects.push(own.id)
      await setMembership(brain, sharedIn.id, u.id, 'viewer')
      expect((await listUserOverview(brain)).find(x => x.id === u.id)).toMatchObject({ owned: 1, reach: 2 })
    })

    it('promotes and demotes, and removing someone who owns projects is refused until they are moved', async () => {
      const u = await createUser(brain, { username: name('promoted'), password })
      expect(await setUserRole(brain, u.id, 'admin')).toBe(true)
      expect((await getUserById(brain, u.id))?.role).toBe('admin')
      expect(await setUserRole(brain, u.id, 'member')).toBe(true)

      const keeper = await createProject(brain, u.id, name('keeper'))
      projects.push(keeper.id)
      await expect(removeUser(brain, u.id)).rejects.toThrow(/still owns/)
      await deleteProject(brain, keeper.id)

      const { token } = await createApiToken(brain, name('promoted-token'), u.username)
      expect(await findApiToken(brain, token)).not.toBeNull()
      expect(await removeUser(brain, u.id)).toBe(true)
      expect(await getUserById(brain, u.id)).toBeNull()
      expect(await findApiToken(brain, token)).toBeNull()
      expect(await removeUser(brain, u.id)).toBe(false)
    })
  })

  describe('token scopes', () => {
    it('a read-only token reads and never writes, whatever its user may do', async () => {
      const p = await project(admin, 'readonly-target')
      const { token, info } = await createApiToken(brain, name('ro'), admin.username, { readOnly: true })
      expect(info).toMatchObject({ readOnly: true, projects: [] })
      const found = (await findApiToken(brain, token))!
      expect(found.scope).toEqual({ readOnly: true, projects: null })

      const scoped: Principal = { ...admin, scope: found.scope! }
      expect(await authorize(brain, scoped, 'memory.read', p.id)).toBe('owner')
      for (const action of ['memory.write', 'memory.delete', 'project.update', 'member.manage', 'project.delete'] as const) {
        await expect(authorize(brain, scoped, action, p.id), action).rejects.toMatchObject({ code: 'forbidden', reason: 'token' })
      }
      // and the same for a solo-mode caller: the limit is the person's own choice
      await expect(authorize(brain, { ...scoped, solo: true }, 'memory.write', p.id)).rejects.toMatchObject({ reason: 'token' })
      await expect(registerProject(brain, { projectId: name('by-ro') }, { allowCreate: true }, scoped)).rejects.toMatchObject({ reason: 'scope' })
    })

    it('a project-limited token sees only its projects, by id and by name', async () => {
      const inside = await project(admin, 'inside')
      const outside = await project(admin, 'outside')
      const { token, info } = await createApiToken(brain, name('limited-token'), admin.username, { projects: [inside.id, inside.id] })
      expect(info.projects).toEqual([inside.id])
      const scope = (await findApiToken(brain, token))!.scope!
      expect(scope).toEqual({ readOnly: false, projects: [inside.id] })
      const p: Principal = { ...admin, scope }

      expect(await authorize(brain, p, 'memory.write', inside.id)).toBe('owner')
      await expect(authorize(brain, p, 'memory.read', outside.id)).rejects.toMatchObject({ code: 'not_found' })
      expect(await findAccessibleProject(brain, p, inside.id)).toMatchObject({ id: inside.id })
      expect(await findAccessibleProject(brain, p, outside.id)).toBeNull()
      expect(await findAccessibleProject(brain, p, outside.name)).toBeNull()
      const reach = await accessibleProjectIds(brain, p)
      expect(reach).toContain(inside.id)
      expect(reach).not.toContain(outside.id)
      expect(await accessibleProjectIds(brain, { ...p, solo: true })).toEqual([inside.id])
      await expect(registerProject(brain, { projectId: name('by-limited') }, { allowCreate: true }, p)).rejects.toMatchObject({ reason: 'scope' })
    })

    it('an ordinary token has no scope, and a revoked one stops working', async () => {
      const { token, info } = await createApiToken(brain, name('plain'), admin.username)
      expect((await findApiToken(brain, token))!.scope).toBeNull()
      expect(await revokeApiToken(brain, info.id)).toBe(true)
      expect(await findApiToken(brain, token)).toBeNull()
    })
  })

  describe('audit log', () => {
    it('lists newest first, filters by prefix, pages with a cursor, and keeps secrets out', async () => {
      await recordAudit(brain, { actor: name('admin'), action: 'invite.created', target: name('a'), detail: 'member' })
      await new Promise(r => setTimeout(r, 15))
      await recordAudit(brain, { actor: name('admin'), action: 'member.changed', target: name('p'), detail: 'editor aib_rNvYxu2-7lVJz_nGe7tW0Qs5H6jtHvj4' })
      await new Promise(r => setTimeout(r, 15))
      await recordAudit(brain, { actor: name('admin'), action: 'invite.revoked', target: name('b') })

      const mine = (await listAudit(brain, { limit: 50 })).filter(e => e.actor === name('admin'))
      expect(mine.map(e => e.action)).toEqual(['invite.revoked', 'member.changed', 'invite.created'])
      expect(JSON.stringify(mine)).not.toContain('aib_rNv')

      const invites = (await listAudit(brain, { action: 'invite.', limit: 50 })).filter(e => e.actor === name('admin'))
      expect(invites.map(e => e.action)).toEqual(['invite.revoked', 'invite.created'])

      const older = (await listAudit(brain, { before: mine[0]!.at, limit: 50 })).filter(e => e.actor === name('admin'))
      expect(older.map(e => e.action)).toEqual(['member.changed', 'invite.created'])
    })

    it('never throws, even for input it cannot store', async () => {
      await expect(recordAudit(brain, { actor: null, action: 'x'.repeat(500) })).resolves.toBeUndefined()
    })
  })
})
