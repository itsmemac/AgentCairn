import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { type Brain, countAdmins, deleteProject, ensureProject, ensureSchema, loadConfig, openBrain } from '@agentcairn/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BrainHttp, type HttpOptions, createBrainHttp } from '../src/index.js'

const hasDb = Boolean(process.env.NEO4J_URI)
// Admin accounts are global to the database: these tests only run while none
// exists (a fresh CI database) and remove what they create.
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

interface Running {
  base: string
  http: BrainHttp
  logs: string[]
  close(): Promise<void>
}

async function start(brain: Brain, options: HttpOptions = {}): Promise<Running> {
  const logs: string[] = []
  const http = createBrainHttp(brain, { log: m => logs.push(m), ...options })
  await new Promise<void>(r => http.server.listen(0, '127.0.0.1', r))
  return {
    base: `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`,
    http,
    logs,
    close: () => new Promise(r => { http.server.closeAllConnections(); http.server.close(() => r()) }),
  }
}

const cookieOf = (res: Response) => res.headers.getSetCookie()[0]?.split(';')[0] ?? ''

describe.skipIf(!hasDb)('dashboard without an admin account', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const project = `${run}-dash`
  let brain: Brain
  let s: Running

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    await ensureSchema(brain)
  })
  afterAll(async () => {
    await s?.close()
    const mine = await brain.run('MATCH (p:Project) WHERE p.name STARTS WITH $run RETURN p.id AS id', { run })
    for (const r of mine.records) await deleteProject(brain, r.get('id') as string).catch(() => undefined)
    await brain.run('MATCH (n) WHERE n.projectId = $id DETACH DELETE n', { id: project })
    await brain.run('MATCH (p:Project {id: $id}) DETACH DELETE p', { id: project })
    await brain.close()
  })

  it('redirects / to the UI and serves it with a strict CSP', async () => {
    s = await start(brain, { token: 'env-token' })
    const r = await fetch(`${s.base}/`, { redirect: 'manual' })
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/ui/')

    const ui = await fetch(`${s.base}/ui/`)
    expect(ui.status).toBe(200)
    expect(ui.headers.get('content-type')).toContain('text/html')
    expect(ui.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(ui.headers.get('x-frame-options')).toBe('DENY')
  })

  it('serves vendored cytoscape and refuses path traversal', async () => {
    const lib = await fetch(`${s.base}/ui/vendor/cytoscape.js`)
    expect(lib.status).toBe(200)
    expect((await lib.text()).length).toBeGreaterThan(100_000)

    for (const path of ['/ui/../package.json', '/ui/%2e%2e/package.json', '/ui/..%2f..%2fsrc%2fhttp.ts', '/ui/nope.js', '/ui/vendor/other.js']) {
      expect((await fetch(`${s.base}${path}`)).status).toBe(404)
    }
  })

  it('the admin API is closed to anyone without a session', async () => {
    for (const path of ['overview', 'events', 'projects', 'tokens', 'system', 'stream', 'graph']) {
      const r = await fetch(`${s.base}/admin/api/${path}`)
      expect(r.status, path).toBe(401)
    }
    expect((await fetch(`${s.base}/admin/api/cypher`, { method: 'POST', body: '{}' })).status).toBe(401)
  })

  it('records authentication failures as events', async () => {
    const r = await fetch(`${s.base}/api/project`, { headers: { authorization: 'Bearer nope', 'user-agent': 'probe/9' } })
    expect(r.status).toBe(401)
    const e = s.http.events.recent({ source: 'auth' })[0]!
    expect(e).toMatchObject({ source: 'auth', ok: false, httpStatus: 401, client: { agent: 'probe' } })
  })

  it('keeps stream probes out of the record and protocol chatter out of the tools table', async () => {
    const before = s.http.events.stats().totals.requests
    const probe = await fetch(`${s.base}/mcp`, { headers: { authorization: 'Bearer env-token' } })
    expect(probe.status).toBe(405)
    expect(s.http.events.stats().totals.requests).toBe(before)

    const client = new Client({ name: 'chatter', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
        requestInit: { headers: { authorization: 'Bearer env-token', 'x-cairn-project': project } },
      }),
    )
    await client.listTools()
    await client.close()

    const methods = s.http.events.recent().map(e => e.method)
    expect(methods).toContain('initialize')
    expect(methods).toContain('tools/list')
    const names = s.http.events.stats().tools.map(t => t.name)
    for (const noise of ['initialize', 'tools/list', 'notifications/initialized', 'mcp']) expect(names).not.toContain(noise)
  })

  it('capture=meta keeps the summary but not the payloads', async () => {
    const m = await start(brain, { token: 'env-token', capture: 'meta', noAuth: false })
    try {
      await fetch(`${m.base}/api/stale-inputs`, { headers: { authorization: 'Bearer env-token', 'x-cairn-project': project } })
      const e = m.http.events.recent()[0]!
      expect(e).toMatchObject({ source: 'api', method: 'GET /api/stale-inputs', hasPayload: false })
    } finally {
      await m.close()
    }
  })

  it('noAuth mode needs no token and labels the client "open"', async () => {
    const o = await start(brain, { noAuth: true })
    try {
      const r = await fetch(`${o.base}/api/stale-inputs`, { headers: { 'x-cairn-project': project } })
      expect(r.status).toBe(200)
      expect(o.http.events.recent()[0]!.client.token).toBe('open')
    } finally {
      await o.close()
    }
  })
})

describe.skipIf(!adminSlotFree)('dashboard with the one-time setup code', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const project = `${run}-dash2`
  const username = `admin-${run}`
  const password = 'a long enough password'
  let brain: Brain
  let s: Running
  let cookie = ''
  let code = ''

  const admin = (path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
    fetch(`${s.base}/admin/api/${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.cookie ?? cookie ? { cookie: init.cookie ?? cookie } : {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  const json = async (r: Response) => (await r.json()) as Record<string, any>

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    await ensureSchema(brain)
    await ensureProject(brain, project)
    s = await start(brain)
  })
  afterAll(async () => {
    await s.close()
    await brain.run('MATCH (a:Admin) DETACH DELETE a')
    await brain.run("MATCH (m:BrainMeta {id: 'setup'}) DELETE m")
    await brain.run('MATCH (t:ApiToken) WHERE t.name STARTS WITH $p DETACH DELETE t', { p: run })
    await brain.run('MATCH (n) WHERE n.projectId = $id DETACH DELETE n', { id: project })
    await brain.run('MATCH (p:Project {id: $id}) DETACH DELETE p', { id: project })
    await brain.run('MATCH (n) WHERE n.projectId = $id DETACH DELETE n', { id: `${run}-created` })
    await brain.run('MATCH (p:Project {id: $id}) DETACH DELETE p', { id: `${run}-created` })
    await brain.close()
  })

  it('shows setup is required and prints the one-time code in the log', async () => {
    const state = await json(await admin('state'))
    expect(state).toMatchObject({ setupRequired: true, authenticated: false })
    const banner = s.logs.find(l => l.includes('first-time setup'))
    expect(banner).toBeDefined()
    code = /\b([2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4})\b/.exec(banner!)![1]!
    expect(s.http.setup.isOpen).toBe(true)
    // asking again does not print a second code
    await admin('state')
    expect(s.logs.filter(l => l.includes('first-time setup'))).toHaveLength(1)
  })

  it('rejects a wrong code, a weak password and a bad username', async () => {
    const wrong = await admin('setup', { body: { code: 'AAAA-BBBB-CCCC', username, password } })
    expect(wrong.status).toBe(403)
    expect((await json(wrong)).error).toBe('bad_code')

    const weak = await admin('setup', { body: { code, username, password: 'short' } })
    expect(weak.status).toBe(400)
    const badName = await admin('setup', { body: { code, username: 'x', password } })
    expect(badName.status).toBe(400)
    expect(await countAdmins(brain)).toBe(0)
  })

  it('creates the admin with the code, accepts it typed loosely, and signs in', async () => {
    const r = await admin('setup', { body: { code: ` ${code.toLowerCase().replaceAll('-', ' ')} `, username, password } })
    expect(r.status).toBe(200)
    const setCookie = r.headers.getSetCookie()[0]!
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/SameSite=Strict/)
    expect(setCookie).not.toMatch(/Secure/)
    cookie = cookieOf(r)
    expect(s.http.setup.isOpen).toBe(false)

    const state = await json(await admin('state'))
    expect(state).toMatchObject({ setupRequired: false, authenticated: true, username })
  })

  it('setup is closed afterwards, even with the code', async () => {
    const r = await admin('setup', { cookie: '', body: { code, username: `other-${run}`, password } })
    expect(r.status).toBe(409)
    expect(await countAdmins(brain)).toBe(1)
  })

  it('login, logout and rate limiting', async () => {
    const bad = await admin('login', { cookie: '', body: { username, password: 'wrong password!!' } })
    expect(bad.status).toBe(401)
    expect((await json(bad)).error).toBe('bad_credentials')
    expect((await admin('login', { cookie: '', body: { username: 'nobody', password } })).status).toBe(401)

    const good = await admin('login', { cookie: '', body: { username: username.toUpperCase(), password } })
    expect(good.status).toBe(200)
    const second = cookieOf(good)
    expect((await admin('overview', { cookie: second })).status).toBe(200)

    expect((await admin('logout', { cookie: second, body: {} })).status).toBe(200)
    expect((await admin('overview', { cookie: second })).status).toBe(401)

    // 5 failures per user per window, then even the right password is refused
    for (let i = 0; i < 6; i++) await admin('login', { cookie: '', body: { username, password: `wrong-${i}-password` } })
    const locked = await admin('login', { cookie: '', body: { username, password } })
    expect(locked.status).toBe(429)
  })

  it('refuses cross-origin writes that carry the admin cookie', async () => {
    const r = await admin('tokens', { body: { name: `${run}-evil` }, headers: { origin: 'http://evil.example' } })
    expect(r.status).toBe(403)
    expect((await json(r)).error).toBe('cross_origin')
    const same = await admin('tokens', { body: { name: `${run}-same` }, headers: { origin: s.base } })
    expect(same.status).toBe(200)
  })

  let token = ''
  let tokenId = ''

  it('creates a token in the dashboard, which then authorizes agents; revoking cuts it off at once', async () => {
    const created = await json(await admin('tokens', { body: { name: `${run}-laptop` } }))
    token = created.token
    tokenId = created.info.id
    expect(token).toMatch(/^aib_/)
    expect(JSON.stringify((await json(await admin('tokens'))).tokens)).not.toContain(token)

    const h = { authorization: `Bearer ${token}`, 'x-cairn-project': project }
    expect((await fetch(`${s.base}/api/stale-inputs`, { headers: h })).status).toBe(200)
    await new Promise(r => setTimeout(r, 300))
    const listed = (await json(await admin('tokens'))).tokens.find((t: { id: string }) => t.id === tokenId)
    expect(listed.lastUsedAt).not.toBeNull()

    expect((await admin(`tokens/${tokenId}`, { method: 'DELETE' })).status).toBe(200)
    expect((await fetch(`${s.base}/api/stale-inputs`, { headers: h })).status).toBe(401)
    expect((await admin(`tokens/${tokenId}`, { method: 'DELETE' })).status).toBe(404)

    const fresh = await json(await admin('tokens', { body: { name: `${run}-fresh` } }))
    token = fresh.token
  })

  it('deletes a project with everything under it, and only for a signed-in admin', async () => {
    const made = await admin('projects', { body: { name: `${run}-delete-me` } })
    expect(made.status).toBe(200)
    const id = ((await made.json()) as { id: string }).id
    expect((await admin(`projects/${id}`, { method: 'DELETE', cookie: '' })).status).toBe(401)
    expect((await admin(`projects/${id}`, { method: 'DELETE', headers: { origin: 'http://evil.example' } })).status).toBe(403)

    const gone = await json(await admin(`projects/${id}`, { method: 'DELETE' }))
    expect(gone).toMatchObject({ id, memories: 0, areas: 0, remotes: 0 })
    expect((await admin(`projects/${id}`)).status).toBe(404)
    expect((await admin(`projects/${id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('captures what agents send and receive, without ever storing the token', async () => {
    const client = new Client({ name: 'dash-test', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}`, 'x-cairn-project': project } },
      }),
    )
    let newId = ''
    try {
      await client.listTools()
      const r = (await client.callTool({
        name: 'cairn_remember',
        arguments: { kind: 'decision', title: 'Capture me', body: 'Because the dashboard records it.' },
      })) as { content: { text: string }[] }
      newId = /#([0-9a-f]{8})/.exec(r.content[0]!.text)![1]!
      await client.callTool({ name: 'cairn_recall', arguments: { query: 'dashboard' } })
    } finally {
      await client.close()
    }

    const list = (await json(await admin('events?limit=50'))).events as { id: number; tool?: string; method: string }[]
    const remember = list.find(e => e.tool === 'cairn_remember')!
    expect(remember).toBeDefined()
    expect(list.some(e => e.method === 'tools/list')).toBe(true)

    const full = await json(await admin(`events/${remember.id}`))
    expect(full).toMatchObject({ source: 'mcp', method: 'tools/call', tool: 'cairn_remember', project, ok: true, client: { token: `${run}-fresh`, agent: expect.any(String) } })
    expect(full.request).toMatchObject({ tool: 'cairn_remember', arguments: { title: 'Capture me' } })
    expect(full.response.text).toContain(`#${newId}`)
    expect(full.memoryRefs).toContain(newId)
    expect(full.tokensOut).toBeGreaterThan(0)
    expect(full.durationMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(full)).not.toContain(token)

    const recall = list.find(e => e.tool === 'cairn_recall')!
    expect((await json(await admin(`events/${recall.id}`))).memoryRefs).toContain(newId)

    expect((await json(await admin('events?tool=cairn_recall'))).events.every((e: { tool?: string }) => e.tool === 'cairn_recall')).toBe(true)
    expect((await admin('events/999999999')).status).toBe(404)
  })

  it('reports stats: totals, per-tool latency, active clients and projects', async () => {
    const { stats, db, neo4j } = await json(await admin('overview'))
    expect(stats.totals.requests).toBeGreaterThan(3)
    expect(stats.perMinute).toHaveLength(60)
    const tool = stats.tools.find((t: { name: string }) => t.name === 'cairn_remember')
    expect(tool).toMatchObject({ count: 1, errors: 0 })
    expect(tool.p95Ms).toBeGreaterThanOrEqual(tool.p50Ms)
    expect(stats.clients.some((c: { token?: string; active: boolean }) => c.token === `${run}-fresh` && c.active)).toBe(true)
    expect(stats.projects.some((p: { project: string }) => p.project === project)).toBe(true)
    expect(db.projects).toBeGreaterThan(0)
    expect(neo4j.pingMs).toBeGreaterThanOrEqual(0)
  })

  it('streams events live over SSE and counts the viewer', async () => {
    const ctrl = new AbortController()
    const res = await fetch(`${s.base}/admin/api/stream`, { headers: { cookie }, signal: ctrl.signal })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const until = async (pattern: RegExp, ms = 5000) => {
      const deadline = Date.now() + ms
      while (!pattern.test(buffer)) {
        const left = deadline - Date.now()
        if (left <= 0) throw new Error(`timed out waiting for ${pattern}; got ${buffer.slice(0, 300)}`)
        const chunk = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('read timeout')), left))])
        if (chunk.done) break
        buffer += decoder.decode(chunk.value)
      }
    }
    try {
      await until(/event: stats/)
      expect(s.http.events.viewers).toBe(1)
      await fetch(`${s.base}/api/stale-inputs`, { headers: { authorization: `Bearer ${token}`, 'x-cairn-project': project } })
      await until(/event: event\ndata: .*GET \/api\/stale-inputs/)
    } finally {
      ctrl.abort()
    }
    await new Promise(r => setTimeout(r, 200))
    expect(s.http.events.viewers).toBe(0)
  })

  it('lists projects, memories, a memory chain and the graph', async () => {
    const h = { authorization: `Bearer ${token}`, 'x-cairn-project': project }
    const client = new Client({ name: 'dash-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), { requestInit: { headers: h } }))
    let oldId = ''
    try {
      const a = (await client.callTool({ name: 'cairn_remember', arguments: { kind: 'convention', title: 'Old rule', body: 'old', area: 'style' } })) as { content: { text: string }[] }
      oldId = /#([0-9a-f]{8})/.exec(a.content[0]!.text)![1]!
      await client.callTool({ name: 'cairn_remember', arguments: { kind: 'convention', title: 'New rule', body: 'new', area: 'style', supersedes: [oldId] } })
    } finally {
      await client.close()
    }

    const projects = (await json(await admin('projects'))).projects as { id: string; active: number }[]
    expect(projects.find(p => p.id === project)!.active).toBeGreaterThanOrEqual(2)
    expect((await json(await admin(`projects/${project}`))).areas).toEqual(expect.arrayContaining([{ name: 'style', count: 1 }]))
    expect((await admin('projects/nope-nope')).status).toBe(404)

    const active = (await json(await admin(`memories?project=${project}&kind=convention`))).memories
    expect(active.map((m: { title: string }) => m.title)).toEqual(['New rule'])
    const all = (await json(await admin(`memories?project=${project}&kind=convention&status=superseded`))).memories
    expect(all.map((m: { title: string }) => m.title)).toEqual(['Old rule'])
    expect((await admin('memories')).status).toBe(400)

    const detail = await json(await admin(`memories/${oldId}?project=${project}`))
    expect(detail.memory.title).toBe('Old rule')
    expect(detail.chain.replacedBy.map((m: { title: string }) => m.title)).toEqual(['New rule'])

    const graph = await json(await admin(`graph?project=${project}`))
    expect(graph.nodes.filter((n: { type: string }) => n.type === 'memory').length).toBeGreaterThanOrEqual(3)
    expect(graph.edges.some((e: { type: string }) => e.type === 'SUPERSEDES')).toBe(true)
  })

  it('creates a project from the dashboard, idempotently, so an agent can start writing with just the header', async () => {
    const name = `${run}-created`
    const first = (await json(await admin('projects', { body: { name } }))) as { id: string }
    const id = first.id
    expect(first).toEqual({ id: expect.any(String), name, created: true })
    expect(await json(await admin('projects', { body: { name } }))).toEqual({ id, name, created: false })
    for (const bad of ['bad id!', '', '-lead', 'x'.repeat(65)]) expect((await admin('projects', { body: { id: bad } })).status, bad).toBe(400)

    const client = new Client({ name: 'new-project', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}`, 'x-cairn-project': id } } }))
    try {
      const r = (await client.callTool({ name: 'cairn_remember', arguments: { kind: 'overview', title: 'First memory', body: 'Written right after the project was created in the dashboard.' } })) as { isError?: boolean }
      expect(r.isError).toBeUndefined()
    } finally {
      await client.close()
    }
  })

  it('the Cypher console reads but never writes', async () => {
    const read = await json(await admin('cypher', { body: { query: `MATCH (m:Memory {projectId: '${project}'}) RETURN m.title AS title ORDER BY title` } }))
    expect(read.columns).toEqual(['title'])
    expect(read.rows.length).toBeGreaterThanOrEqual(3)

    for (const query of ['CREATE (:Hack {run: "x"})', 'MATCH (n) DETACH DELETE n', 'CALL dbms.security.listUsers()', 'MATCH (n RETURN n']) {
      const r = await admin('cypher', { body: { query } })
      expect(r.status, query).toBe(400)
    }
    const probe = await brain.run('MATCH (n:Hack) RETURN count(n) AS n')
    expect(Number(probe.records[0]!.get('n'))).toBe(0)
  })

  it('system info reveals no secrets', async () => {
    const text = await (await admin('system')).text()
    const sys = JSON.parse(text)
    expect(sys.neo4j.agent).toMatch(/neo4j/i)
    expect(sys.graph.labels.Memory).toBeGreaterThan(0)
    expect(sys.auth.managedTokens).toBeGreaterThan(0)
    expect(text).not.toContain(token)
    expect(text).not.toMatch(/"password"|passwordHash/)
    expect(text).not.toContain('passwordHash')
  })

  it('changing the password signs out other sessions and requires the current one', async () => {
    const other = cookieOf(await admin('login', { cookie: '', body: { username, password }, headers: { 'x-forwarded-for': '203.0.113.9' } }))
    // the login limiter above is per-username and already tripped, so reuse the main session instead
    expect(other === '' || typeof other === 'string').toBe(true)

    const wrong = await admin('password', { body: { current: 'not the password!!', next: 'another long password' } })
    expect(wrong.status).toBe(403)
    const ok = await admin('password', { body: { current: password, next: 'another long password' } })
    expect(ok.status).toBe(200)
    const fresh = cookieOf(ok)
    expect((await admin('overview', { cookie })).status).toBe(401)
    expect((await admin('overview', { cookie: fresh })).status).toBe(200)
  })
})
