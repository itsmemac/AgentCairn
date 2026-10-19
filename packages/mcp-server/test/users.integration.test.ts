import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { type Brain, createUser, deleteProject, loadConfig, openBrain } from '@agentcairn/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpServer } from '../src/index.js'

type Call = { content: { type: string; text: string }[]; isError?: boolean }
const text = (r: unknown) => (r as Call).content.map(c => c.text).join('\n')

// A team using one server: an admin who invites people, members who share projects, and tokens with limits.
describe.skipIf(!process.env.NEO4J_URI)('users, invitations, sharing and token limits through the server', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const password = 'correct horse battery'
  const un = (n: string) => `${run}-${n}`
  let brain: Brain
  let base: string
  let server: ReturnType<typeof createHttpServer>
  const projects: string[] = []
  const cookies = new Map<string, string>()
  const ids: Record<string, string> = {}

  async function login(username: string, pw = password): Promise<string> {
    const cached = cookies.get(username)
    if (cached) return cached
    const r = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: pw }) })
    expect(r.status, `login ${username}`).toBe(200)
    const cookie = r.headers.getSetCookie()[0]!.split(';')[0]!
    cookies.set(username, cookie)
    return cookie
  }
  const dash = async (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}/admin/api/${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { cookie: await login(who), ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  const pub = (path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}/admin/api/${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  const json = async (r: Response) => (await r.json()) as Record<string, any>

  const connect = async (token: string, headers: Record<string, string>) => {
    const client = new Client({ name: 'users-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } } }))
    return client
  }
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Call

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    for (const [who, role] of [['boss', 'admin'], ['ann', 'member'], ['ben', 'member']] as const) {
      ids[who] = (await createUser(brain, { username: un(who), password, role })).id
    }
    server = createHttpServer(brain, {})
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise(r => server.close(r))
    for (const id of projects.filter(Boolean)) await deleteProject(brain, id).catch(() => undefined)
    await brain.run('MATCH (i:Invite) WHERE i.createdByName STARTS WITH $run DETACH DELETE i', { run })
    await brain.run('MATCH (t:ApiToken) WHERE t.createdBy STARTS WITH $run DETACH DELETE t', { run })
    await brain.run('MATCH (a:Audit) WHERE a.actor STARTS WITH $run OR a.target STARTS WITH $run DETACH DELETE a', { run })
    await brain.run('MATCH (u:User) WHERE u.username STARTS WITH $run DETACH DELETE u', { run })
    await brain.close()
  })

  it('only an admin can see people, invitations and the audit log, or change either', async () => {
    for (const path of ['users', 'audit']) {
      expect((await dash(un('ann'), path)).status, path).toBe(403)
      expect((await dash(un('boss'), path)).status, path).toBe(200)
    }
    expect((await dash(un('ann'), 'invites', { body: { role: 'member' } })).status).toBe(403)
    expect((await dash(un('ann'), `users/${ids.ben}`, { method: 'PATCH', body: { role: 'admin' } })).status).toBe(403)
    expect((await dash(un('ann'), `users/${ids.ben}`, { method: 'DELETE' })).status).toBe(403)
    expect((await pub('users')).status).toBe(401)
    expect((await pub('invites', { body: { role: 'member' } })).status).toBe(401)
  })

  it('an invitation link creates a signed-in account once, and then it is dead', async () => {
    const proj = await json(await dash(un('boss'), 'projects', { body: { name: un('welcome-project') } }))
    projects.push(proj.id)
    const made = await json(await dash(un('boss'), 'invites', { body: { role: 'member', grants: [{ projectId: proj.id, role: 'editor' }], maxProjects: 3 } }))
    expect(made.token).toMatch(/^inv_/)
    expect(made.info).toMatchObject({ status: 'pending', role: 'member', maxProjects: 3 })

    const peek = await pub(`invite/${made.token}`)
    expect(peek.status).toBe(200)
    const shown = await json(peek)
    expect(shown).toMatchObject({ kind: 'join', role: 'member', invitedBy: un('boss'), grants: [{ projectName: un('welcome-project'), role: 'editor' }] })
    expect(JSON.stringify(shown)).not.toContain(made.token)

    const weak = await pub(`invite/${made.token}/accept`, { body: { username: un('newcomer'), password: 'short' } })
    expect(weak.status).toBe(400)
    const accepted = await pub(`invite/${made.token}/accept`, { body: { username: un('newcomer'), password } })
    expect(accepted.status).toBe(200)
    expect((await json(accepted)).username).toBe(un('newcomer'))
    const cookie = accepted.headers.getSetCookie()[0]!.split(';')[0]!
    cookies.set(un('newcomer'), cookie)

    // signed in at once, with the access the link granted
    const me = await json(await dash(un('newcomer'), 'projects'))
    expect(me.projects.map((p: { name: string; role: string }) => `${p.name}${p.role}`)).toContain(`${un('welcome-project')}editor`)

    expect((await pub(`invite/${made.token}`)).status).toBe(404)
    const reuse = await pub(`invite/${made.token}/accept`, { body: { username: un('second'), password } })
    expect(reuse.status).toBe(410)
    expect((await json(reuse)).error).toBe('invite_gone')
    expect((await pub('invite/inv_' + 'z'.repeat(43))).status).toBe(404)
  })

  it('shows pending links to the admin, and a withdrawn link stops working', async () => {
    const made = await json(await dash(un('boss'), 'invites', { body: { role: 'member' } }))
    const list = await json(await dash(un('boss'), 'users'))
    expect(list.invites.find((i: { id: string }) => i.id === made.info.id)).toMatchObject({ status: 'pending' })
    expect((await dash(un('boss'), `invites/${made.info.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await dash(un('boss'), `invites/${made.info.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await pub(`invite/${made.token}`)).status).toBe(404)
    expect((await dash(un('boss'), 'invites', { body: { role: 'member', username: '!' } })).status).toBe(400)
  })

  it('a reset link sets a new password for an existing account', async () => {
    const made = await json(await dash(un('boss'), 'invites', { body: { kind: 'reset', forUserId: ids.ben } }))
    expect((await json(await pub(`invite/${made.token}`)))).toMatchObject({ kind: 'reset', forUsername: un('ben') })
    const done = await pub(`invite/${made.token}/accept`, { body: { password: 'a different passphrase' } })
    expect(done.status).toBe(200)
    expect((await pub('login', { body: { username: un('ben'), password } })).status).toBe(401)
    expect((await pub('login', { body: { username: un('ben'), password: 'a different passphrase' } })).status).toBe(200)
    cookies.delete(un('ben'))
    // give Ben his old password back for the rest of the tests
    const again = await json(await dash(un('boss'), 'invites', { body: { kind: 'reset', forUserId: ids.ben } }))
    await pub(`invite/${again.token}/accept`, { body: { password } })
  })

  it('disabling someone ends their sessions and their tokens at once, and re-enabling restores them', async () => {
    const token = (await json(await dash(un('ann'), 'tokens', { body: { name: un('ann-token') } }))).token as string
    const probe = () => fetch(`${base}/api/stale-inputs`, { headers: { authorization: `Bearer ${token}`, 'x-cairn-project': 'whatever' } })
    expect((await probe()).status).toBe(200)

    const off = await dash(un('boss'), `users/${ids.ann}`, { method: 'PATCH', body: { status: 'disabled' } })
    expect(off.status).toBe(200)
    expect((await json(off)).user.status).toBe('disabled')
    expect((await probe()).status).toBe(401)
    expect((await dash(un('ann'), 'projects')).status).toBe(401) // her old session is gone
    cookies.delete(un('ann'))
    expect((await pub('login', { body: { username: un('ann'), password } })).status).toBe(401)

    await dash(un('boss'), `users/${ids.ann}`, { method: 'PATCH', body: { status: 'active' } })
    expect((await probe()).status).toBe(200)
    expect((await pub('login', { body: { username: un('ann'), password } })).status).toBe(200)
    expect((await dash(un('boss'), `users/${ids.boss}`, { method: 'PATCH', body: { status: 'disabled' } })).status).toBe(400) // not yourself
    expect((await dash(un('boss'), `users/${ids.boss}`, { method: 'DELETE' })).status).toBe(400)
    expect((await dash(un('boss'), `users/${ids.ann}`, { method: 'PATCH', body: { role: 'wizard' } })).status).toBe(400)
  })

  it('a project limit stops creating more, and removing the limit lifts it', async () => {
    expect((await dash(un('boss'), `users/${ids.ben}`, { method: 'PATCH', body: { maxProjects: 0 } })).status).toBe(200)
    const blocked = await dash(un('ben'), 'projects', { body: { name: un('too-many') } })
    expect(blocked.status).toBe(403)
    expect((await json(blocked)).error).toBe('project_limit')
    await dash(un('boss'), `users/${ids.ben}`, { method: 'PATCH', body: { maxProjects: null } })
    const made = await json(await dash(un('ben'), 'projects', { body: { name: un('now-allowed') } }))
    projects.push(made.id)
    expect(made.created).toBe(true)
  })

  it('shares by username, changes and removes roles, hands a project over, and lets someone leave', async () => {
    const made = await json(await dash(un('ann'), 'projects', { body: { name: un('shared') } }))
    projects.push(made.id)
    const id = made.id as string

    expect((await dash(un('ann'), 'users/lookup?username=nobody-here')).status).toBe(404)
    expect(await json(await dash(un('ann'), `users/lookup?username=${un('ben')}`))).toMatchObject({ id: ids.ben, username: un('ben') })

    expect((await dash(un('ann'), `projects/${id}/members`, { body: { username: un('ben'), role: 'owner' } })).status).toBe(400)
    expect((await dash(un('ann'), `projects/${id}/members`, { body: { username: 'nobody-here', role: 'viewer' } })).status).toBe(404)
    const added = await json(await dash(un('ann'), `projects/${id}/members`, { body: { username: un('ben'), role: 'viewer' } }))
    expect(added.members.map((m: { username: string; role: string }) => `${m.username}:${m.role}`)).toEqual([`${un('ann')}:owner`, `${un('ben')}:viewer`])

    // Ben sees it with his role, but cannot manage it
    const seen = (await json(await dash(un('ben'), 'projects'))).projects.find((p: { id: string }) => p.id === id)
    expect(seen).toMatchObject({ role: 'viewer', owner: un('ann') })
    expect((await json(await dash(un('ben'), `projects/${id}`))).role).toBe('viewer')
    expect((await dash(un('ben'), `projects/${id}/members`, { body: { username: un('boss'), role: 'viewer' } })).status).toBe(403)
    expect((await dash(un('ben'), `projects/${id}/transfer`, { body: { username: un('ben') } })).status).toBe(403)

    expect((await dash(un('ann'), `projects/${id}/members/${ids.ben}`, { method: 'PUT', body: { role: 'maintainer' } })).status).toBe(200)
    expect((await dash(un('ben'), `projects/${id}/members`, { body: { username: un('boss'), role: 'viewer' } })).status).toBe(200) // a maintainer manages members

    const handed = await json(await dash(un('ann'), `projects/${id}/transfer`, { body: { username: un('ben') } }))
    expect(handed.members.map((m: { username: string; role: string }) => `${m.username}:${m.role}`)).toEqual(expect.arrayContaining([`${un('ben')}:owner`, `${un('ann')}:maintainer`]))
    expect((await dash(un('ann'), `projects/${id}`, { method: 'DELETE' })).status).toBe(403) // no longer hers to delete

    // anyone may leave; the owner may not
    expect((await dash(un('ann'), `projects/${id}/members/${ids.ann}`, { method: 'DELETE' })).status).toBe(200)
    expect((await dash(un('ann'), `projects/${id}`)).status).toBe(404)
    expect((await dash(un('ben'), `projects/${id}/members/${ids.ben}`, { method: 'DELETE' })).status).toBe(400)
  })

  it('a removed account loses its tokens, and someone who owns projects cannot be removed yet', async () => {
    const owner = await createUser(brain, { username: un('doomed'), password })
    const own = await json(await dash(un('boss'), 'projects', { body: { name: un('boss-owned') } }))
    projects.push(own.id)
    cookies.set(un('doomed'), await login(un('doomed')))
    const theirs = await json(await dash(un('doomed'), 'projects', { body: { name: un('doomed-owned') } }))
    projects.push(theirs.id)
    const refuse = await dash(un('boss'), `users/${owner.id}`, { method: 'DELETE' })
    expect(refuse.status).toBe(400)
    expect((await json(refuse)).message).toContain('still owns')
    await deleteProject(brain, theirs.id)
    expect((await dash(un('boss'), `users/${owner.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await pub('login', { body: { username: un('doomed'), password } })).status).toBe(401)
  })

  it('a read-only token reads and cannot write, and a project-limited token cannot see anything else', async () => {
    const mine = await json(await dash(un('ann'), 'projects', { body: { name: un('scoped-a') } }))
    const other = await json(await dash(un('ann'), 'projects', { body: { name: un('scoped-b') } }))
    projects.push(mine.id, other.id)

    // a token cannot be limited to a project its owner cannot reach
    expect((await dash(un('ben'), 'tokens', { body: { name: un('sneaky'), projects: [mine.id] } })).status).toBe(404)

    const ro = await json(await dash(un('ann'), 'tokens', { body: { name: un('ro'), readOnly: true } }))
    expect(ro.info).toMatchObject({ readOnly: true, projects: [] })
    const reader = await connect(ro.token, { 'x-cairn-project': mine.id })
    try {
      const writeAttempt = await call(reader, 'cairn_remember', { kind: 'gotcha', title: 'Should not land', body: 'x' })
      expect(writeAttempt.isError).toBe(true)
      expect(text(writeAttempt)).toContain('read-only')
      expect((await call(reader, 'cairn_handoff', { goal: 'x', next: ['y'] })).isError).toBe(true)
      expect(text(await call(reader, 'cairn_recall', {}))).toContain('No matching memories')
    } finally {
      await reader.close()
    }
    const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { authorization: `Bearer ${ro.token}`, 'x-cairn-project': mine.id, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'ro-session' }) })
    expect(session.status).toBe(403)

    const lim = await json(await dash(un('ann'), 'tokens', { body: { name: un('lim'), projects: [mine.id] } }))
    expect(lim.info.projects).toEqual([mine.id])
    const inside = await connect(lim.token, { 'x-cairn-project': mine.id })
    const outside = await connect(lim.token, { 'x-cairn-project': other.id })
    try {
      expect((await call(inside, 'cairn_remember', { kind: 'gotcha', title: 'Inside', body: 'fine' })).isError).toBeUndefined()
      const refused = await call(outside, 'cairn_remember', { kind: 'gotcha', title: 'Outside', body: 'no' })
      expect(refused.isError).toBe(true)
      expect(text(refused)).toContain('does not exist')
      expect(text(await call(outside, 'cairn_briefing'))).toContain('(empty)')
    } finally {
      await inside.close()
      await outside.close()
    }
    // and a limited token cannot start a project of its own from a repository
    const fresh = await connect(lim.token, { 'x-cairn-remote': `example.com/${run}/brand-new` })
    try {
      const attempt = await call(fresh, 'cairn_remember', { kind: 'gotcha', title: 'New project?', body: 'no' })
      expect(attempt.isError).toBe(true)
      expect(text(attempt)).toContain('cannot create new ones')
    } finally {
      await fresh.close()
    }
    const listed = (await json(await dash(un('ann'), 'tokens'))).tokens.find((t: { id: string }) => t.id === lim.info.id)
    expect(listed).toMatchObject({ projects: [mine.id], readOnly: false })
  })

  it('leaves a trail an admin can read, and only an admin', async () => {
    const trail = (await json(await dash(un('boss'), 'audit?limit=200'))).events as { actor: string | null; action: string; target: string | null; detail: string | null }[]
    const mine = trail.filter(e => e.actor?.startsWith(run) || e.target?.startsWith(run))
    const actions = new Set(mine.map(e => e.action))
    for (const expected of ['invite.created', 'invite.accepted', 'invite.revoked', 'user.disabled', 'user.enabled', 'user.limit', 'user.removed', 'member.added', 'member.changed', 'member.left', 'project.transferred', 'project.created', 'token.created', 'login', 'login.failed']) {
      expect(actions, expected).toContain(expected)
    }
    expect(JSON.stringify(mine)).not.toContain('inv_')
    expect(JSON.stringify(mine)).not.toContain(password)

    const onlyInvites = (await json(await dash(un('boss'), 'audit?action=invite.&limit=200'))).events as { action: string }[]
    expect(onlyInvites.length).toBeGreaterThan(0)
    expect(onlyInvites.every(e => e.action.startsWith('invite.'))).toBe(true)

    const console = await dash(un('boss'), 'cypher', { body: { query: 'MATCH (n:BrainMeta) RETURN count(n) AS n' } })
    expect(console.status).toBe(200)
    const after = (await json(await dash(un('boss'), 'audit?action=console.&limit=5'))).events as { actor: string; action: string; detail: string }[]
    expect(after.find(e => e.actor === un('boss'))).toMatchObject({ action: 'console.query' })
  })
})
