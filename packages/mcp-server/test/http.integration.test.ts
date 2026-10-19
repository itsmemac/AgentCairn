import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { type Brain, deleteProject, findProjectByRemote, getMemory, loadConfig, openBrain, projectExists, remoteHash } from '@agentcairn/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpServer } from '../src/index.js'

type Call = { content: { type: string; text: string }[]; isError?: boolean }
const text = (r: unknown) => (r as Call).content.map(c => c.text).join('\n')
const shortIdIn = (s: string) => /#([0-9a-f]{8})/.exec(s)![1]!

describe.skipIf(!process.env.NEO4J_URI)('HTTP server against a live Neo4j', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const token = `tok-${randomBytes(8).toString('hex')}`
  const remote = `example.com/${run}/${run}-app`
  // projects get generated ids: these are filled in as the tests create them
  let remoteProject = ''
  let explicitId = ''
  const explicit = `${run}-explicit`
  const aliasRemote = `example.com/${run}/alias`
  const secondRemote = `example.com/${run}/second`
  const sha = 'a'.repeat(40)
  let brain: Brain
  let base: string
  let server: ReturnType<typeof createHttpServer>

  const api = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; auth?: boolean } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.auth === false ? {} : { authorization: `Bearer ${token}` }),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })

  const connect = async (headers: Record<string, string>) => {
    const client = new Client({ name: 'http-test', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } },
      }),
    )
    return client
  }
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as Call

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    server = createHttpServer(brain, { token })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise(r => server.close(r))
    const byRemote = await brain.run('MATCH (r:Remote)-[:BELONGS_TO]->(p:Project) WHERE r.hash IN $hashes RETURN DISTINCT p.id AS id', {
      hashes: [remote, aliasRemote, secondRemote].map(remoteHash),
    })
    const ids = new Set([remoteProject, explicitId, ...byRemote.records.map(r => r.get('id') as string)].filter(Boolean))
    for (const id of ids) await deleteProject(brain, id)
    await brain.close()
  })

  it('health check needs no token', async () => {
    const r = await api('/healthz', { auth: false })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ status: 'ok' })
  })

  it('rejects missing and wrong tokens on /mcp and /api', async () => {
    for (const path of ['/mcp', '/api/project']) {
      expect((await api(path, { auth: false })).status).toBe(401)
      expect((await api(path, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    }
  })

  it('/mcp is POST only and unknown paths are 404', async () => {
    expect((await api('/mcp')).status).toBe(405)
    expect((await api('/nope')).status).toBe(404)
  })

  it('serves MCP over HTTP, identifying the project by remote header', async () => {
    const client = await connect({ 'x-cairn-remote': remote })
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(9)

      expect(text(await call(client, 'cairn_briefing'))).toContain('(empty)')
      expect(await findProjectByRemote(brain, remoteHash(remote))).toBeNull()

      const r = await call(client, 'cairn_remember', {
        kind: 'gotcha',
        title: 'Cache is per-process',
        body: 'Do not rely on it across workers.',
        paths: ['src/cache.ts'],
        commit_sha: sha,
        author: 'Test User',
      })
      expect(r.isError).toBeUndefined()
      remoteProject = (await findProjectByRemote(brain, remoteHash(remote)))!
      expect(remoteProject).toMatch(/^prj_[0-9a-f]{12}$/)
      expect(await projectExists(brain, remoteProject)).toBe(true)
      const named = await brain.run('MATCH (p:Project {id: $id}) RETURN p.name AS name', { id: remoteProject })
      expect(named.records[0]?.get("name")).toBe(`${run}-app`)
      const m = await getMemory(brain, remoteProject, shortIdIn(text(r)))
      expect(m).toMatchObject({ commitSha: sha, author: 'Test User', paths: ['src/cache.ts'] })

      expect(text(await call(client, 'cairn_briefing'))).toContain('Cache is per-process')
      expect(text(await call(client, 'cairn_status'))).toContain(`Project: ${remoteProject} (via git remote)`)
      expect(text(await call(client, 'cairn_briefing'))).toContain('Cache is per-process')
    } finally {
      await client.close()
    }
  })

  it('ignores a made-up commit sha instead of storing it', async () => {
    const client = await connect({ 'x-cairn-remote': remote })
    try {
      const r = await call(client, 'cairn_remember', {
        kind: 'gotcha',
        title: 'Bad sha',
        body: 'x',
        paths: ['a.ts'],
        commit_sha: 'not a sha; DROP',
      })
      expect((await getMemory(brain, remoteProject, shortIdIn(text(r))))?.commitSha).toBeNull()
    } finally {
      await client.close()
    }
  })

  it('without a project header the agent is told to run cairn init', async () => {
    const client = await connect({})
    try {
      const r = await call(client, 'cairn_briefing')
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('cairn init')
    } finally {
      await client.close()
    }
  })

  it('/api/init: refuses unknown ids unless allowed, creates, links remotes, reports conflicts', async () => {
    const missing = await api('/api/init', { body: { projectId: explicit } })
    expect(missing.status).toBe(404)
    expect((await missing.json()).error).toBe('project_not_found')

    const created = await api('/api/init', {
      body: { projectId: explicit, remote: 'https://user:secret@Example.com/' + run + '/alias.git', allowCreate: true },
    })
    const made = await created.json()
    expect(made).toEqual({ projectId: expect.stringMatching(/^prj_[0-9a-f]{12}$/), name: explicit, created: true, remoteAttached: true })
    explicitId = made.projectId

    // the same name is the same project, not a second one
    expect(await (await api('/api/init', { body: { projectId: explicit } })).json()).toMatchObject({ projectId: explicitId, created: false })

    const conflict = await api('/api/init', { body: { projectId: remoteProject, remote: aliasRemote } })
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).ownerProjectId).toBe(explicitId)

    const forced = await api('/api/init', { body: { projectId: remoteProject, remote: aliasRemote, forceRemote: true } })
    expect(forced.status).toBe(200)

    expect((await api('/api/init', { body: { remote: 'not a remote' } })).status).toBe(400)
    expect((await api('/api/init', { body: { projectId: '   ', allowCreate: true } })).status).toBe(400)
  })

  it('/api/project, /api/stale-inputs and /api/briefing work for a remote client', async () => {
    const h = { 'x-cairn-project': remoteProject }
    const info = await (await api('/api/project', { headers: h })).json()
    expect(info).toMatchObject({ projectId: remoteProject, source: 'link', isNew: false })
    expect(info.total).toBeGreaterThan(0)

    const { inputs } = await (await api('/api/stale-inputs', { headers: h })).json()
    expect(inputs).toContainEqual(expect.objectContaining({ commitSha: sha, paths: ['src/cache.ts'] }))
    const id = inputs.find((i: { paths: string[] }) => i.paths[0] === 'src/cache.ts').id

    const plain = await (await api('/api/briefing', { headers: h, body: {} })).json()
    expect(plain.status).toBe('ready')
    expect(plain.text).not.toContain('may be stale')

    const stale = await (
      await api('/api/briefing', { headers: h, body: { maxTokens: 400, stale: [{ id, changedPaths: ['src/cache.ts'] }] } })
    ).json()
    expect(stale.staleIds).toEqual([id])
    expect(stale.text).toContain('may be stale (changed: src/cache.ts)')
    expect(stale.tokens).toBeLessThanOrEqual(400)
  })

  it('/api/remote adds an alias to an existing project only', async () => {
    const other = secondRemote
    const r = await api('/api/remote', { headers: { 'x-cairn-project': explicitId }, body: { remote: other } })
    expect(r.status).toBe(200)

    const ghost = await api('/api/remote', { headers: { 'x-cairn-project': `${run}-ghost` }, body: { remote: other } })
    expect(ghost.status).toBe(404)
  })

  it('rejects oversized and malformed bodies', async () => {
    expect((await api('/api/init', { headers: { 'content-type': 'application/json' }, body: undefined, method: 'POST' })).status).toBe(400)
    const bad = await fetch(`${base}/api/init`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{nope',
    })
    expect(bad.status).toBe(400)
  })
})
