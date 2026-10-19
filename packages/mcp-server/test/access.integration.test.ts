import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  type Brain,
  createApiToken,
  createUser,
  deleteProject,
  findProjectByRemote,
  loadConfig,
  openBrain,
  remoteHash,
  setMembership,
} from '@agentcairn/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpServer } from '../src/index.js'

type Call = { content: { type: string; text: string }[]; isError?: boolean }
const text = (r: unknown) => (r as Call).content.map(c => c.text).join('\n')
const shortIdIn = (s: string) => /#([0-9a-f]{8})/.exec(s)![1]!

// Two people, each with their own token and their own projects, against the real HTTP server.
describe.skipIf(!process.env.NEO4J_URI)('users and sharing through the server', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const password = 'correct horse battery'
  const names = { alice: `${run}-alice`, bob: `${run}-bob` }
  const remote = `example.com/${run}/${run}-repo`
  let brain: Brain
  let base: string
  let server: ReturnType<typeof createHttpServer>
  let tokens: { alice: string; bob: string }
  let ids: { alice: string; bob: string }
  const projects: string[] = []

  const connect = async (who: 'alice' | 'bob', headers: Record<string, string>) => {
    const client = new Client({ name: 'access-test', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${tokens[who]}`, ...headers } },
      }),
    )
    return client
  }
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as Call

  async function login(who: 'alice' | 'bob'): Promise<string> {
    const r = await fetch(`${base}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: names[who], password }),
    })
    expect(r.status).toBe(200)
    return r.headers.getSetCookie()[0]!.split(';')[0]!
  }
  const dash = (cookie: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}/admin/api/${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { cookie, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    const a = await createUser(brain, { username: names.alice, password })
    const b = await createUser(brain, { username: names.bob, password })
    ids = { alice: a.id, bob: b.id }
    tokens = {
      alice: (await createApiToken(brain, `${run}-a`, names.alice)).token,
      bob: (await createApiToken(brain, `${run}-b`, names.bob)).token,
    }
    server = createHttpServer(brain, {})
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise(r => server.close(r))
    const byRemote = await brain.run('MATCH (r:Remote)-[:BELONGS_TO]->(p:Project) WHERE r.hash = $hash RETURN p.id AS id', { hash: remoteHash(remote) })
    for (const id of new Set([...projects, ...byRemote.records.map(r => r.get('id') as string)])) await deleteProject(brain, id)
    await brain.run('MATCH (t:ApiToken) WHERE t.createdBy STARTS WITH $run DETACH DELETE t', { run })
    await brain.run('MATCH (u:User) WHERE u.username STARTS WITH $run DETACH DELETE u', { run })
    await brain.close()
  })

  let aliceProject = ''
  let secretId = ''

  it('the same repository gives each person their own private project, named after it', async () => {
    const alice = await connect('alice', { 'x-cairn-remote': remote })
    const bob = await connect('bob', { 'x-cairn-remote': remote })
    try {
      const mine = await call(alice, 'cairn_remember', { kind: 'gotcha', title: 'Alice only', body: 'A private fact.' })
      expect(mine.isError).toBeUndefined()
      secretId = shortIdIn(text(mine))
      aliceProject = (await brain.run('MATCH (u:User {id: $id})-[:MEMBER_OF {role: "owner"}]->(p:Project) RETURN p.id AS id', { id: ids.alice })).records[0]!.get('id') as string
      projects.push(aliceProject)

      // Bob is on the same repository, but sees none of it
      expect(text(await call(bob, 'cairn_briefing'))).toContain('(empty)')
      expect(text(await call(bob, 'cairn_recall', { query: 'private' }))).not.toContain('Alice only')

      const theirs = await call(bob, 'cairn_remember', { kind: 'gotcha', title: 'Bob only', body: 'Another private fact.' })
      expect(theirs.isError).toBeUndefined()
      const bobProject = (await brain.run('MATCH (u:User {id: $id})-[:MEMBER_OF {role: "owner"}]->(p:Project) RETURN p.id AS id', { id: ids.bob })).records[0]!.get('id') as string
      projects.push(bobProject)
      expect(bobProject).not.toBe(aliceProject)
      expect(await findProjectByRemote(brain, remoteHash(remote), { userId: ids.alice, username: names.alice, role: 'member' })).toBe(aliceProject)
      expect(text(await call(alice, 'cairn_recall', { query: 'Bob' }))).not.toContain('Bob only')
    } finally {
      await alice.close()
      await bob.close()
    }
  })

  it("naming someone else's private project by id gets nothing, and cannot write", async () => {
    const bob = await connect('bob', { 'x-cairn-project': aliceProject })
    try {
      expect(text(await call(bob, 'cairn_briefing'))).toContain('(empty)')
      const w = await call(bob, 'cairn_remember', { kind: 'gotcha', title: 'Break in', body: 'Should not land.' })
      expect(w.isError).toBe(true)
      expect(text(w)).toContain('does not exist')
      const gone = await call(bob, 'cairn_forget', { id: secretId })
      expect(gone.isError).toBe(true)
    } finally {
      await bob.close()
    }
  })

  it('a shared project: viewer reads only, editor writes, maintainer deletes', async () => {
    const asBob = () => connect('bob', { 'x-cairn-project': aliceProject })
    const write = (c: Client) => call(c, 'cairn_remember', { kind: 'gotcha', title: `By Bob ${Math.random()}`, body: 'x' })

    await setMembership(brain, aliceProject, ids.bob, 'viewer')
    let bob = await asBob()
    try {
      expect(text(await call(bob, 'cairn_recall', { query: 'private' }))).toContain('Alice only')
      const denied = await write(bob)
      expect(denied.isError).toBe(true)
      expect(text(denied)).toContain('memory.write')
    } finally {
      await bob.close()
    }

    await setMembership(brain, aliceProject, ids.bob, 'editor')
    bob = await asBob()
    try {
      const wrote = await write(bob)
      expect(wrote.isError).toBeUndefined()
      const cannot = await call(bob, 'cairn_forget', { id: shortIdIn(text(wrote)) })
      expect(cannot.isError).toBe(true)
      expect(text(cannot)).toContain('memory.delete')
    } finally {
      await bob.close()
    }

    await setMembership(brain, aliceProject, ids.bob, 'maintainer')
    bob = await asBob()
    try {
      const gone = await call(bob, 'cairn_forget', { id: secretId })
      expect(gone.isError).toBeUndefined()
      expect(text(gone)).toContain('Deleted')
    } finally {
      await bob.close()
    }
  })

  it('the agent API follows the same rules', async () => {
    const headers = (who: 'alice' | 'bob') => ({ authorization: `Bearer ${tokens[who]}`, 'x-cairn-project': aliceProject })
    await brain.run('MATCH (:User {id: $id})-[m:MEMBER_OF]->(:Project {id: $p}) DELETE m', { id: ids.bob, p: aliceProject })
    const hidden = await fetch(`${base}/api/stale-inputs`, { headers: headers('bob') })
    expect(hidden.status).toBe(200) // an unknown project reads as empty, not as forbidden
    expect((await hidden.json()).inputs).toEqual([])
    const alone = await fetch(`${base}/api/remote`, { method: 'POST', headers: { ...headers('bob'), 'content-type': 'application/json' }, body: JSON.stringify({ remote: 'example.com/x/y' }) })
    expect(alone.status).toBe(404)

    await setMembership(brain, aliceProject, ids.bob, 'editor')
    const editorRemote = await fetch(`${base}/api/remote`, { method: 'POST', headers: { ...headers('bob'), 'content-type': 'application/json' }, body: JSON.stringify({ remote: 'example.com/x/y' }) })
    expect(editorRemote.status).toBe(403)
    expect((await editorRemote.json()).error).toBe('forbidden')
  })

  it("the dashboard shows each user only what they can reach, and keeps the admin tools to admins", async () => {
    await brain.run('MATCH (:User {id: $id})-[m:MEMBER_OF]->(:Project {id: $p}) DELETE m', { id: ids.bob, p: aliceProject })
    const bob = await login('bob')
    const alice = await login('alice')

    const listed = async (cookie: string) => ((await (await dash(cookie, 'projects')).json()).projects as { id: string }[]).map(p => p.id)
    expect(await listed(alice)).toContain(aliceProject)
    expect(await listed(bob)).not.toContain(aliceProject)
    expect((await dash(bob, `projects/${aliceProject}`)).status).toBe(404)
    expect((await dash(bob, `memories?project=${aliceProject}`)).status).toBe(404)
    expect((await dash(bob, `graph?project=${aliceProject}`)).status).toBe(404)
    const graph = await (await dash(bob, 'graph')).json()
    expect(JSON.stringify(graph)).not.toContain(aliceProject)

    // sharing is a dashboard action for the owner
    expect((await dash(bob, `projects/${aliceProject}/members/${ids.bob}`, { method: 'PUT', body: { role: 'maintainer' } })).status).toBe(404)
    const shared = await dash(alice, `projects/${aliceProject}/members/${ids.bob}`, { method: 'PUT', body: { role: 'viewer' } })
    expect(shared.status).toBe(200)
    expect((await shared.json()).members.map((m: { username: string; role: string }) => `${m.username}:${m.role}`)).toContain(`${names.bob}:viewer`)
    expect(await listed(bob)).toContain(aliceProject)
    expect((await dash(alice, `projects/${aliceProject}/members/${ids.bob}`, { method: 'PUT', body: { role: 'owner' } })).status).toBe(400)

    // a viewer cannot manage members or delete, but may leave
    expect((await dash(bob, `projects/${aliceProject}/members/${ids.alice}`, { method: 'DELETE' })).status).toBe(403)
    expect((await dash(bob, `projects/${aliceProject}`, { method: 'DELETE' })).status).toBe(403)
    expect((await dash(bob, `projects/${aliceProject}/members/${ids.bob}`, { method: 'DELETE' })).status).toBe(200)
    expect((await dash(bob, `projects/${aliceProject}`)).status).toBe(404)

    // admin-only surfaces
    for (const path of ['system', 'users', 'events']) expect((await dash(bob, path)).status, path).toBe(403)
    expect((await dash(bob, 'cypher', { body: { query: 'MATCH (n) RETURN n LIMIT 1' } })).status).toBe(403)

    // tokens: only your own
    const own = (await (await dash(bob, 'tokens')).json()).tokens as { createdBy: string }[]
    expect(own.length).toBeGreaterThan(0)
    expect(own.every(t => t.createdBy === names.bob)).toBe(true)
  })

  it('creating a project in the dashboard makes you its owner, and the same name is the same project', async () => {
    const bob = await login('bob')
    const made = await (await dash(bob, 'projects', { body: { name: `${run}-fresh` } })).json()
    projects.push(made.id)
    expect(made).toMatchObject({ name: `${run}-fresh`, created: true })
    expect(made.id).toMatch(/^prj_/)
    const again = await (await dash(bob, 'projects', { body: { name: `${run}-fresh` } })).json()
    expect(again).toMatchObject({ id: made.id, created: false })
    expect((await dash(bob, `projects/${made.id}`, { method: 'DELETE' })).status).toBe(200)
  })
})
