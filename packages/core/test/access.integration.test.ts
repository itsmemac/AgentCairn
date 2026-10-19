import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ACTIONS,
  AccessError,
  type Brain,
  MembershipError,
  PROJECT_ROLES,
  type Principal,
  ProjectNameError,
  RemoteConflictError,
  SOLO_PRINCIPAL,
  accessibleProjectIds,
  attachRemote,
  authorize,
  countActiveUsers,
  createProject,
  createUser,
  deleteProject,
  ensureSchema,
  findAccessibleProject,
  findProjectByRemote,
  getUserById,
  listMembers,
  listProjects,
  loadConfig,
  migrateUsers,
  openBrain,
  principalOf,
  projectExists,
  registerProject,
  remember,
  removeMembership,
  resolveProjectFromHint,
  roleAllows,
  setMembership,
  setUserStatus,
  transferOwnership,
  verifyUser,
} from '../src/index.js'

describe('roles and actions', () => {
  // the whole policy in one place: who may do what
  const allowed: Record<string, string[]> = {
    viewer: ['memory.read'],
    editor: ['memory.read', 'memory.write'],
    maintainer: ['memory.read', 'memory.write', 'memory.delete', 'project.update', 'member.manage'],
    owner: ['memory.read', 'memory.write', 'memory.delete', 'project.update', 'member.manage', 'project.delete'],
  }

  it('matches the documented matrix for every role and action', () => {
    for (const role of PROJECT_ROLES) {
      for (const action of ACTIONS) {
        expect(roleAllows(role, action), `${role} / ${action}`).toBe(allowed[role]!.includes(action))
      }
    }
  })
})

describe.skipIf(!process.env.NEO4J_URI)('users, sharing and visibility against a live Neo4j', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const password = 'correct horse battery'
  let brain: Brain
  let alice: Principal
  let bob: Principal
  let carol: Principal
  let dave: Principal
  const made: string[] = []
  const names = (n: string) => `${run}-${n}`

  async function user(name: string, role: 'admin' | 'member' = 'member'): Promise<Principal> {
    const u = await createUser(brain, { username: names(name), password, role })
    return principalOf(u)
  }
  async function project(owner: Principal, name: string) {
    const p = await createProject(brain, owner.userId, names(name))
    made.push(p.id)
    return p
  }

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    await ensureSchema(brain)
    ;[alice, bob, carol, dave] = await Promise.all([user('alice'), user('bob'), user('carol'), user('dave')])
  })

  afterAll(async () => {
    for (const id of made) await deleteProject(brain, id)
    await brain.run('MATCH (u:User) WHERE u.username STARTS WITH $prefix DETACH DELETE u', { prefix: run })
    await brain.run('MATCH (a:Admin) WHERE a.username STARTS WITH $prefix DETACH DELETE a', { prefix: run })
    await brain.close()
  })

  it('a database on this schema still accepts the startup statements of the previous server image', async () => {
    // Upgrades are gradual: the old image may keep running against the same Neo4j for a while.
    const previousImage = [
      'CREATE CONSTRAINT project_id IF NOT EXISTS FOR (p:Project) REQUIRE p.id IS UNIQUE',
      'CREATE CONSTRAINT remote_hash IF NOT EXISTS FOR (r:Remote) REQUIRE r.hash IS UNIQUE',
      'CREATE CONSTRAINT area_id IF NOT EXISTS FOR (a:Area) REQUIRE a.id IS UNIQUE',
      'CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE',
      'CREATE INDEX memory_project_kind IF NOT EXISTS FOR (m:Memory) ON (m.projectId, m.kind)',
      'CREATE FULLTEXT INDEX memory_text IF NOT EXISTS FOR (m:Memory) ON EACH [m.title, m.body]',
      'CREATE CONSTRAINT brainmeta_id IF NOT EXISTS FOR (m:BrainMeta) REQUIRE m.id IS UNIQUE',
      'CREATE CONSTRAINT admin_username IF NOT EXISTS FOR (a:Admin) REQUIRE a.username IS UNIQUE',
      'CREATE CONSTRAINT token_id IF NOT EXISTS FOR (t:ApiToken) REQUIRE t.id IS UNIQUE',
      'CREATE CONSTRAINT token_hash IF NOT EXISTS FOR (t:ApiToken) REQUIRE t.hash IS UNIQUE',
    ]
    await ensureSchema(brain)
    for (const statement of previousImage) await brain.run(statement)
    await ensureSchema(brain) // and the new code is happy after the old one has run
  })

  it('generates unique ids; names repeat across owners but not within one', async () => {
    const a = await project(alice, 'shared-name')
    const b = await project(bob, 'shared-name')
    expect(a.id).toMatch(/^prj_[0-9a-f]{12}$/)
    expect(a.id).not.toBe(b.id)
    expect(a.name).toBe(b.name)
    await expect(createProject(brain, alice.userId, names('shared-name'))).rejects.toMatchObject({ code: 'exists' })
    await expect(createProject(brain, alice.userId, '  ')).rejects.toBeInstanceOf(ProjectNameError)
  })

  it('a new project is private to its owner: others get "not found", never "forbidden"', async () => {
    const p = await project(alice, 'private')
    expect(await authorize(brain, alice, 'project.delete', p.id)).toBe('owner')
    await expect(authorize(brain, bob, 'memory.read', p.id)).rejects.toMatchObject({ code: 'not_found' })
    expect(await accessibleProjectIds(brain, bob)).not.toContain(p.id)
    expect((await listProjects(brain, { projectIds: await accessibleProjectIds(brain, bob) })).map(x => x.id)).not.toContain(p.id)
    expect(await findAccessibleProject(brain, bob, p.id)).toBeNull()
    expect(await findAccessibleProject(brain, bob, p.name)).toBeNull()
    const hidden = await resolveProjectFromHint(brain, { projectId: p.id }, bob)
    expect(hidden.isNew).toBe(true)
  })

  it('each role gets exactly what the matrix allows, and the owner role is never handed out', async () => {
    const p = await project(alice, 'roles')
    for (const role of ['viewer', 'editor', 'maintainer'] as const) {
      await setMembership(brain, p.id, bob.userId, role)
      for (const action of ACTIONS) {
        const result = authorize(brain, bob, action, p.id)
        if (roleAllows(role, action)) await expect(result, `${role} / ${action}`).resolves.toBe(role)
        else await expect(result, `${role} / ${action}`).rejects.toMatchObject({ code: 'forbidden' })
      }
    }
    await expect(setMembership(brain, p.id, bob.userId, 'owner')).rejects.toBeInstanceOf(MembershipError)
    await expect(setMembership(brain, p.id, alice.userId, 'viewer')).rejects.toBeInstanceOf(MembershipError)
    await expect(removeMembership(brain, p.id, alice.userId)).rejects.toBeInstanceOf(MembershipError)
  })

  it('sharing makes a project visible with that role; removing the member hides it again', async () => {
    const p = await project(alice, 'sharing')
    await setMembership(brain, p.id, carol.userId, 'viewer')
    expect(await accessibleProjectIds(brain, carol)).toContain(p.id)
    expect(await findAccessibleProject(brain, carol, p.id)).toMatchObject({ id: p.id })
    expect((await resolveProjectFromHint(brain, { projectId: p.id }, carol)).isNew).toBe(false)
    expect((await listMembers(brain, p.id)).map(m => `${m.username}:${m.role}`)).toEqual([`${names('alice')}:owner`, `${names('carol')}:viewer`])

    expect(await removeMembership(brain, p.id, carol.userId)).toBe(true)
    await expect(authorize(brain, carol, 'memory.read', p.id)).rejects.toBeInstanceOf(AccessError)
  })

  it('transferring ownership makes the old owner a maintainer, with one owner throughout', async () => {
    const p = await project(alice, 'transfer')
    await setMembership(brain, p.id, bob.userId, 'editor')
    await transferOwnership(brain, p.id, bob.userId)
    const roles = Object.fromEntries((await listMembers(brain, p.id)).map(m => [m.username, m.role]))
    expect(roles).toEqual({ [names('alice')]: 'maintainer', [names('bob')]: 'owner' })
    await expect(authorize(brain, alice, 'project.delete', p.id)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await authorize(brain, bob, 'project.delete', p.id)).toBe('owner')
  })

  it('finds a project by name among those you can access: yours first, ambiguity asks for the id', async () => {
    const mineAndTheirs = names('twin')
    const theirs = await createProject(brain, dave.userId, mineAndTheirs)
    made.push(theirs.id)
    await setMembership(brain, theirs.id, alice.userId, 'viewer')
    const mine = await createProject(brain, alice.userId, mineAndTheirs)
    made.push(mine.id)
    expect(await findAccessibleProject(brain, alice, mineAndTheirs)).toEqual(mine)

    const one = await createProject(brain, carol.userId, names('amb'))
    const two = await createProject(brain, dave.userId, names('amb'))
    made.push(one.id, two.id)
    await setMembership(brain, one.id, bob.userId, 'viewer')
    await setMembership(brain, two.id, bob.userId, 'viewer')
    await expect(findAccessibleProject(brain, bob, names('amb'))).rejects.toMatchObject({ code: 'ambiguous' })
    expect(await findAccessibleProject(brain, bob, one.id)).toMatchObject({ id: one.id })
  })

  it('git remote aliases are per project: two people on one repository get their own projects', async () => {
    const remote = `example.com/${run}/shared-repo`
    const hash = `h${randomBytes(6).toString('hex')}`
    const a = await registerProject(brain, { remoteHash: hash, remote }, {}, alice)
    const b = await registerProject(brain, { remoteHash: hash, remote }, {}, bob)
    made.push(a.projectId, b.projectId)
    expect(a.projectId).not.toBe(b.projectId)
    expect(a.name).toBe('shared-repo')
    expect(await findProjectByRemote(brain, hash, alice)).toBe(a.projectId)
    expect(await findProjectByRemote(brain, hash, bob)).toBe(b.projectId)
    expect(await findProjectByRemote(brain, hash, carol)).toBeNull()

    // registering again finds the same project
    expect((await registerProject(brain, { remoteHash: hash, remote }, {}, alice)).created).toBe(false)

    // a second project of one's own cannot take the same remote without force
    const other = await project(alice, 'other-home')
    await expect(attachRemote(brain, other.id, hash, { principal: alice })).rejects.toBeInstanceOf(RemoteConflictError)
    await attachRemote(brain, other.id, hash, { principal: alice, force: true })
    expect(await findProjectByRemote(brain, hash, alice)).toBe(other.id)
    // and Bob's alias is untouched
    expect(await findProjectByRemote(brain, hash, bob)).toBe(b.projectId)
  })

  it('init by name finds, creates only when allowed, and links a viewer without letting them re-point the remote', async () => {
    await expect(registerProject(brain, { projectId: names('newname') }, {}, alice)).rejects.toMatchObject({ name: 'ProjectNotFoundError' })
    const created = await registerProject(brain, { projectId: names('newname') }, { allowCreate: true }, alice)
    made.push(created.projectId)
    expect(created).toMatchObject({ name: names('newname'), created: true })
    expect((await registerProject(brain, { projectId: names('newname') }, {}, alice)).projectId).toBe(created.projectId)

    await setMembership(brain, created.projectId, bob.userId, 'viewer')
    const hash = `h${randomBytes(6).toString('hex')}`
    const linked = await registerProject(brain, { projectId: created.projectId, remoteHash: hash }, {}, bob)
    expect(linked).toMatchObject({ projectId: created.projectId, created: false, remoteAttached: false })
    expect(await findProjectByRemote(brain, hash, alice)).toBeNull()
  })

  it('a project nobody can see cannot be created by guessing its id', async () => {
    const p = await project(alice, 'guess')
    await expect(registerProject(brain, { projectId: p.id }, {}, bob)).rejects.toMatchObject({ name: 'ProjectNotFoundError' })
    expect(await projectExists(brain, p.id)).toBe(true)
    expect((await listMembers(brain, p.id)).map(m => m.username)).toEqual([names('alice')])
  })

  it('solo mode skips project checks, and a memory written by one user is invisible to another', async () => {
    const p = await project(alice, 'solo')
    expect(await authorize(brain, { ...bob, solo: true }, 'project.delete', p.id)).toBe('owner')
    expect(await accessibleProjectIds(brain, SOLO_PRINCIPAL)).toBeNull()
    await remember(brain, p.id, { kind: 'gotcha', title: 'Private fact', body: 'Only for Alice.' })
    await expect(authorize(brain, bob, 'memory.read', p.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('deleting a project removes its memberships', async () => {
    const p = await createProject(brain, alice.userId, names('gone'))
    await setMembership(brain, p.id, bob.userId, 'editor')
    expect(await deleteProject(brain, p.id)).toMatchObject({ memories: 0 })
    expect(await accessibleProjectIds(brain, bob)).not.toContain(p.id)
    const left = await brain.run('MATCH ()-[m:MEMBER_OF]->(p:Project {id: $id}) RETURN count(m) AS n', { id: p.id })
    expect(Number(left.records[0]?.get('n'))).toBe(0)
  })

  it('a disabled account cannot sign in, and counts are for active users only', async () => {
    const eve = await createUser(brain, { username: names('eve'), password })
    expect(await verifyUser(brain, names('eve'), password)).toMatchObject({ username: names('eve'), status: 'active' })
    const before = await countActiveUsers(brain)
    expect(await setUserStatus(brain, eve.id, 'disabled')).toBe(true)
    expect(await verifyUser(brain, names('eve'), password)).toBeNull()
    expect(await countActiveUsers(brain)).toBe(before - 1)
    expect((await getUserById(brain, eve.id))?.status).toBe('disabled')
    await expect(createUser(brain, { username: names('EVE'), password })).rejects.toMatchObject({ code: 'exists' })
  })

  it('the migration upgrades the old shapes: Admin gains User, projects get names and an owner, remotes get keys', async () => {
    const adminName = names('legacyadmin')
    const legacy = names('legacyproject')
    const hash = `h${randomBytes(6).toString('hex')}`
    made.push(legacy)
    await brain.run("CREATE (:Admin {username: $adminName, passwordHash: 'x', createdAt: datetime()})", { adminName })
    await brain.run('CREATE (p:Project {id: $legacy, createdAt: datetime()}) CREATE (:Remote {hash: $hash})-[:BELONGS_TO]->(p)', { legacy, hash })

    expect(await migrateUsers(brain)).toBe(true)

    const admin = await brain.run('MATCH (a:Admin {username: $adminName}) RETURN a:User AS isUser, a.role AS role, a.status AS status, a.id AS id', { adminName })
    expect(admin.records[0]?.toObject()).toMatchObject({ isUser: true, role: 'admin', status: 'active' })
    expect(admin.records[0]?.get('id')).toBeTruthy()

    const p = await brain.run(
      'MATCH (p:Project {id: $legacy}) OPTIONAL MATCH (:User)-[m:MEMBER_OF {role: "owner"}]->(p) RETURN p.name AS name, count(m) AS owners',
      { legacy },
    )
    expect(p.records[0]?.get('name')).toBe(legacy)
    expect(Number(p.records[0]?.get('owners'))).toBe(1)

    const r = await brain.run('MATCH (r:Remote {hash: $hash}) RETURN r.key AS key', { hash })
    expect(r.records[0]?.get('key')).toBe(`${legacy}:${hash}`)

    // running it again changes nothing
    expect(await migrateUsers(brain)).toBe(false)
  })
})
