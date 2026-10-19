import { readFile } from 'node:fs/promises'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { extname, join, normalize, sep } from 'node:path'
import {
  AdminError,
  type Brain,
  type MemoryKind,
  MEMORY_KINDS,
  type Principal,
  ProjectNameError,
  QueryRejectedError,
  accessibleProjectIds,
  authorize,
  changeAdminPassword,
  checkConnection,
  countActiveTokens,
  countActiveUsers,
  countAdmins,
  createApiToken,
  createFirstAdmin,
  createProject,
  deleteProject,
  findAccessibleProject,
  getGraph,
  getMemory,
  getMemoryChain,
  getProjectDetail,
  ensureSchema,
  getSystemInfo,
  getUserByUsername,
  hasDefaultCredentials,
  isProjectRole,
  listApiTokens,
  listMembers,
  listProjects,
  listUsers,
  loadConfig,
  migrateUsers,
  principalOf,
  removeMembership,
  setMembership,
  recall,
  revokeApiToken,
  runReadOnlyCypher,
  schemaVersion,
  tidySystemNodes,
  verifyAdmin,
} from '@agentcairn/core'
import type { Authenticator } from './authn.js'
import type { EventLog } from './events.js'
import {
  RateLimiter,
  SESSION_COOKIE,
  type SessionStore,
  type SetupGate,
  clearedSessionCookie,
  parseCookies,
  sameOrigin,
  sessionCookie,
  setupBanner,
} from './security.js'
import { HttpError, asRecord, clientIp, readJson, send } from './util.js'

export interface DashboardDeps {
  brain: Brain
  events: EventLog
  auth: Authenticator
  sessions: SessionStore
  setup: SetupGate
  version: string
  port: number
  uiDir: string
  trustProxy: boolean
  secureCookies: boolean
  maxBodyBytes: number
  capture: 'full' | 'meta'
  authMode: { envToken: boolean; noAuth: boolean }
  log: (message: string) => void
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
}

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
}

function vendorFiles(): Record<string, string> {
  try {
    const require = createRequire(import.meta.url)
    return { '/ui/vendor/cytoscape.js': require.resolve('cytoscape/dist/cytoscape.min.js') }
  } catch {
    return {}
  }
}

/**
 * The web dashboard: static UI under /ui/, JSON under /admin/api/. Returns a
 * handler that answers true when it took the request.
 */
export function createDashboard(deps: DashboardDeps): (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean> {
  const { brain, events, auth, sessions, setup } = deps
  const vendor = vendorFiles()
  const loginByIp = new RateLimiter(10, 10 * 60_000)
  const loginByUser = new RateLimiter(5, 10 * 60_000)
  const setupGuesses = new RateLimiter(5, 10 * 60_000)

  let adminCache: { value: number; until: number } | undefined
  const adminCount = async () => {
    if (adminCache && adminCache.until > Date.now()) return adminCache.value
    const value = await countAdmins(brain)
    adminCache = { value, until: Date.now() + 2000 }
    return value
  }

  /** While no admin exists the one-time code is always open (and printed once per opening). */
  async function ensureSetupGate(): Promise<void> {
    if ((await adminCount()) === 0 && !setup.isOpen) deps.log(`\n${setupBanner(setup.open(), deps.port)}\n`)
  }

  const cookieFor = (id: string, maxAge: number) => sessionCookie(id, maxAge, deps.secureCookies)

  function sessionOf(req: IncomingMessage) {
    return sessions.get(parseCookies(req)[SESSION_COOKIE])
  }

  /** Who a signed-in dashboard session acts as. Looked up (briefly cached) so a disabled account loses access quickly. */
  const principals = new Map<string, { principal: Principal | null; until: number }>()
  async function principalFor(username: string): Promise<Principal> {
    const cached = principals.get(username)
    if (cached && cached.until > Date.now()) {
      if (cached.principal) return cached.principal
    } else {
      const user = await getUserByUsername(brain, username)
      const principal = user && user.status === 'active' ? principalOf(user, (await countActiveUsers(brain)) <= 1) : null
      principals.set(username, { principal, until: Date.now() + 3000 })
      if (principal) return principal
    }
    throw new HttpError(401, 'login_required', 'Sign in first.')
  }
  const requireAdmin = (principal: Principal): void => {
    if (principal.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only an admin can do that.')
  }

  async function serveStatic(res: ServerResponse, path: string): Promise<void> {
    const vendored = vendor[path]
    let file: string
    if (vendored) file = vendored
    else {
      const rel = normalize(path.replace(/^\/ui\/?/, '') || 'index.html')
      file = join(deps.uiDir, rel)
      if (rel.startsWith('..') || !file.startsWith(deps.uiDir + sep)) throw new HttpError(404, 'not_found', 'Not found.')
    }
    let body: Buffer
    try {
      body = await readFile(file)
    } catch {
      throw new HttpError(404, 'not_found', 'Not found.')
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
      ...SECURITY_HEADERS,
    })
    res.end(body)
  }

  async function handleAdmin(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET'
    const ip = clientIp(req, deps.trustProxy) ?? 'unknown'
    const url = new URL(req.url ?? '/', 'http://localhost')
    const q = url.searchParams
    const route = path.replace(/^\/admin\/api\//, '')

    if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
      throw new HttpError(403, 'cross_origin', 'Cross-origin request refused.')
    }

    // ---- public ----------------------------------------------------------
    if (route === 'state' && method === 'GET') {
      await ensureSetupGate()
      const session = sessionOf(req)
      const me = session ? await principalFor(session.username).catch(() => null) : null
      return send(res, 200, {
        version: deps.version,
        setupRequired: (await adminCount()) === 0,
        authenticated: Boolean(session && me),
        username: me ? session!.username : null,
        role: me?.role ?? null,
        solo: me?.solo ?? true,
      })
    }

    if (route === 'setup' && method === 'POST') {
      const body = asRecord(await readJson(req, deps.maxBodyBytes))
      if ((await adminCount()) > 0) throw new HttpError(409, 'setup_closed', 'Setup is already complete.')
      await ensureSetupGate()
      if (!setupGuesses.attempt(ip)) {
        throw new HttpError(429, 'rate_limited', `Too many attempts. Try again in ${setupGuesses.retryAfterSeconds(ip)}s.`)
      }
      if (!setup.check(String(body.code ?? ''))) throw new HttpError(403, 'bad_code', 'That setup code is not right.')
      try {
        const admin = await createFirstAdmin(brain, String(body.username ?? ''), String(body.password ?? ''))
        // projects made before there were accounts now belong to the first admin
        await migrateUsers(brain)
        auth.invalidate()
        setup.close()
        adminCache = undefined
        setupGuesses.reset(ip)
        const s = sessions.create(admin.username)
        deps.log(`dashboard: admin "${admin.username}" created`)
        // the first-setup lock has done its job; remove it once any racing attempts are finished with it
        setTimeout(() => void tidySystemNodes(brain).catch(() => undefined), 3000).unref()
        return send(res, 200, { username: admin.username }, { 'set-cookie': cookieFor(s.id, s.maxAgeSeconds) })
      } catch (error) {
        if (error instanceof AdminError) {
          throw new HttpError(error.code === 'setup_closed' ? 409 : 400, error.code === 'setup_closed' ? 'setup_closed' : 'invalid', error.message)
        }
        throw error
      }
    }

    if (route === 'login' && method === 'POST') {
      const body = asRecord(await readJson(req, deps.maxBodyBytes))
      const username = String(body.username ?? '').toLowerCase()
      if (!loginByIp.attempt(ip) || !loginByUser.attempt(username)) {
        throw new HttpError(429, 'rate_limited', `Too many attempts. Try again in ${Math.max(loginByIp.retryAfterSeconds(ip), loginByUser.retryAfterSeconds(username))}s.`)
      }
      const admin = await verifyAdmin(brain, username, String(body.password ?? ''))
      if (!admin) throw new HttpError(401, 'bad_credentials', 'Wrong username or password.')
      loginByUser.reset(username)
      const s = sessions.create(admin.username)
      return send(res, 200, { username: admin.username }, { 'set-cookie': cookieFor(s.id, s.maxAgeSeconds) })
    }

    if (route === 'logout' && method === 'POST') {
      sessions.destroy(parseCookies(req)[SESSION_COOKIE])
      return send(res, 200, { ok: true }, { 'set-cookie': clearedSessionCookie(deps.secureCookies) })
    }

    // ---- everything below needs a session --------------------------------
    const session = sessionOf(req)
    if (!session) throw new HttpError(401, 'login_required', 'Sign in first.')
    const principal = await principalFor(session.username)
    const isAdmin = principal.role === 'admin'

    if (route === 'password' && method === 'POST') {
      const body = asRecord(await readJson(req, deps.maxBodyBytes))
      if (!loginByUser.attempt(`pw:${session.username}`)) throw new HttpError(429, 'rate_limited', 'Too many attempts.')
      try {
        const ok = await changeAdminPassword(brain, session.username, String(body.current ?? ''), String(body.next ?? ''))
        if (!ok) throw new HttpError(403, 'bad_credentials', 'The current password is wrong.')
      } catch (error) {
        if (error instanceof AdminError) throw new HttpError(400, 'invalid', error.message)
        throw error
      }
      sessions.clear()
      const s = sessions.create(session.username)
      return send(res, 200, { ok: true }, { 'set-cookie': cookieFor(s.id, s.maxAgeSeconds) })
    }

    if (route === 'overview' && method === 'GET') {
      const started = Date.now()
      const info = await checkConnection(brain)
      const pingMs = Date.now() - started
      const projects = await listProjects(brain, { projectIds: await accessibleProjectIds(brain, principal) })
      return send(res, 200, {
        stats: isAdmin ? events.stats() : null,
        db: {
          projects: projects.length,
          memories: projects.reduce((a, p) => a + p.active, 0),
          superseded: projects.reduce((a, p) => a + p.superseded, 0),
          tokens: isAdmin ? await countActiveTokens(brain) : (await listApiTokens(brain, { createdBy: principal.username })).filter(t => !t.revokedAt).length,
        },
        neo4j: isAdmin ? { agent: info.agent, address: info.address, pingMs } : null,
        server: { version: deps.version },
      })
    }

    if (route === 'events' && method === 'GET') {
      requireAdmin(principal)
      const ok = q.get('ok')
      return send(res, 200, {
        events: events.recent({
          tool: q.get('tool') ?? undefined,
          project: q.get('project') ?? undefined,
          client: q.get('client') ?? undefined,
          source: q.get('source') ?? undefined,
          ok: ok === null ? undefined : ok === 'true',
          before: q.get('before') ? Number(q.get('before')) : undefined,
          limit: q.get('limit') ? Number(q.get('limit')) : undefined,
        }),
      })
    }

    const eventMatch = /^events\/(\d+)$/.exec(route)
    if (eventMatch && method === 'GET') {
      requireAdmin(principal)
      const event = events.get(Number(eventMatch[1]))
      if (!event) throw new HttpError(404, 'not_found', 'That event has aged out of the buffer.')
      return send(res, 200, event)
    }

    if (route === 'stream' && method === 'GET') {
      requireAdmin(principal)
      return stream(req, res)
    }

    if (route === 'projects' && method === 'GET') {
      return send(res, 200, { projects: await listProjects(brain, { projectIds: await accessibleProjectIds(brain, principal) }) })
    }

    if (route === 'projects' && method === 'POST') {
      const body = asRecord(await readJson(req, deps.maxBodyBytes))
      const name = String(body.name ?? body.id ?? '').trim()
      await ensureSchema(brain)
      // a name you already own is the same project, not a second one
      const existing = await findAccessibleProject(brain, principal, name).catch(() => null)
      const owned = existing && (await authorize(brain, principal, 'project.delete', existing.id).then(() => true, () => false))
      if (existing && owned) return send(res, 200, { id: existing.id, name: existing.name, created: false })
      const made = await createProject(brain, principal.userId, name)
      return send(res, 200, { id: made.id, name: made.name, created: true })
    }

    const projectMatch = /^projects\/([^/]+)$/.exec(route)
    if (projectMatch && method === 'GET') {
      await authorize(brain, principal, 'memory.read', decodeURIComponent(projectMatch[1]!))
      const detail = await getProjectDetail(brain, decodeURIComponent(projectMatch[1]!))
      if (!detail) throw new HttpError(404, 'not_found', 'No such project.')
      return send(res, 200, detail)
    }

    if (projectMatch && method === 'DELETE') {
      const id = decodeURIComponent(projectMatch[1]!)
      await authorize(brain, principal, 'project.delete', id)
      const gone = await deleteProject(brain, id)
      if (!gone) throw new HttpError(404, 'not_found', 'No such project.')
      return send(res, 200, { id, ...gone })
    }

    const membersMatch = /^projects\/([^/]+)\/members(?:\/([^/]+))?$/.exec(route)
    if (membersMatch) {
      const id = decodeURIComponent(membersMatch[1]!)
      const userId = membersMatch[2] ? decodeURIComponent(membersMatch[2]) : undefined
      if (method === 'GET' && !userId) {
        await authorize(brain, principal, 'memory.read', id)
        return send(res, 200, { members: await listMembers(brain, id) })
      }
      if (method === 'PUT' && userId) {
        await authorize(brain, principal, 'member.manage', id)
        const role = asRecord(await readJson(req, deps.maxBodyBytes)).role
        if (!isProjectRole(role) || role === 'owner') throw new HttpError(400, 'invalid', 'Role must be viewer, editor or maintainer.')
        await setMembership(brain, id, userId, role)
        return send(res, 200, { members: await listMembers(brain, id) })
      }
      if (method === 'DELETE' && userId) {
        // you may always leave a project; removing someone else needs member.manage
        if (userId !== principal.userId) await authorize(brain, principal, 'member.manage', id)
        else await authorize(brain, principal, 'memory.read', id)
        if (!(await removeMembership(brain, id, userId))) throw new HttpError(404, 'not_found', 'That user is not a member.')
        return send(res, 200, { members: await listMembers(brain, id) })
      }
    }

    if (route === 'users' && method === 'GET') {
      requireAdmin(principal)
      return send(res, 200, { users: (await listUsers(brain)).map(u => ({ id: u.id, username: u.username, role: u.role, status: u.status, createdAt: u.createdAt })) })
    }

    if (route === 'memories' && method === 'GET') {
      const project = q.get('project')
      if (!project) throw new HttpError(400, 'invalid', 'project is required.')
      await authorize(brain, principal, 'memory.read', project)
      const kind = q.get('kind') as MemoryKind | null
      if (kind && !MEMORY_KINDS.includes(kind)) throw new HttpError(400, 'invalid', 'Unknown kind.')
      const status = q.get('status') ?? 'active'
      const found = await recall(brain, project, {
        query: q.get('q') ?? undefined,
        kind: kind ?? undefined,
        area: q.get('area') ?? undefined,
        limit: q.get('limit') ? Number(q.get('limit')) : 50,
        includeSuperseded: status !== 'active',
      })
      return send(res, 200, { memories: status === 'superseded' ? found.filter(m => m.status === 'superseded') : found })
    }

    const memoryMatch = /^memories\/([^/]+)$/.exec(route)
    if (memoryMatch && method === 'GET') {
      const project = q.get('project')
      if (!project) throw new HttpError(400, 'invalid', 'project is required.')
      await authorize(brain, principal, 'memory.read', project)
      const memory = await getMemory(brain, project, decodeURIComponent(memoryMatch[1]!))
      if (!memory) throw new HttpError(404, 'not_found', 'No such memory.')
      return send(res, 200, { memory, chain: await getMemoryChain(brain, project, memory.id) })
    }

    if (route === 'graph' && method === 'GET') {
      const only = q.get('project') ?? undefined
      if (only) await authorize(brain, principal, 'memory.read', only)
      return send(res, 200, await getGraph(brain, { projectId: only, projectIds: await accessibleProjectIds(brain, principal), limit: q.get('limit') ? Number(q.get('limit')) : undefined }))
    }

    if (route === 'cypher' && method === 'POST') {
      requireAdmin(principal)
      const body = asRecord(await readJson(req, deps.maxBodyBytes))
      try {
        return send(res, 200, await runReadOnlyCypher(brain, String(body.query ?? '')))
      } catch (error) {
        if (error instanceof QueryRejectedError) throw new HttpError(400, 'query_rejected', error.message)
        const e = error as { code?: string; message?: string }
        if (e.code?.startsWith('Neo.ClientError')) throw new HttpError(400, 'query_failed', e.message ?? 'Query failed.')
        throw error
      }
    }

    if (route === 'tokens' && method === 'GET') {
      return send(res, 200, { tokens: await listApiTokens(brain, isAdmin ? {} : { createdBy: principal.username }) })
    }

    if (route === 'tokens' && method === 'POST') {
      const body = asRecord(await readJson(req, deps.maxBodyBytes))
      try {
        const created = await createApiToken(brain, String(body.name ?? ''), session.username)
        auth.invalidate()
        return send(res, 200, created)
      } catch (error) {
        if (error instanceof AdminError) throw new HttpError(400, 'invalid', error.message)
        throw error
      }
    }

    const tokenMatch = /^tokens\/([0-9a-f]+)$/.exec(route)
    if (tokenMatch && method === 'DELETE') {
      if (!(await revokeApiToken(brain, tokenMatch[1]!, isAdmin ? {} : { createdBy: principal.username }))) throw new HttpError(404, 'not_found', 'No such active token.')
      auth.invalidate()
      return send(res, 200, { ok: true })
    }

    if (route === 'system' && method === 'GET') {
      requireAdmin(principal)
      const config = loadConfig()
      const started = Date.now()
      const info = await checkConnection(brain)
      const mem = process.memoryUsage()
      return send(res, 200, {
        server: {
          version: deps.version,
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          pid: process.pid,
          uptimeSeconds: Math.round(process.uptime()),
          rssMb: Math.round(mem.rss / 1048576),
          heapMb: Math.round(mem.heapUsed / 1048576),
        },
        neo4j: {
          agent: info.agent,
          address: info.address,
          uri: config.uri,
          user: config.user,
          defaultCredentials: hasDefaultCredentials(config),
          schemaVersion: await schemaVersion(brain),
          pingMs: Date.now() - started,
        },
        graph: await getSystemInfo(brain),
        auth: { ...deps.authMode, managedTokens: await countActiveTokens(brain) },
        capture: { mode: deps.capture, capacity: events.capacity },
      })
    }

    throw new HttpError(404, 'not_found', `No such endpoint: ${method} ${path}`)
  }

  function stream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const emit = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    res.write('retry: 3000\n\n')
    events.viewers++
    emit('stats', events.stats())
    const unsubscribe = events.subscribe(e => emit('event', e))
    const stats = setInterval(() => emit('stats', events.stats()), 2000)
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
    const cleanup = () => {
      clearInterval(stats)
      clearInterval(ping)
      unsubscribe()
      events.viewers = Math.max(0, events.viewers - 1)
    }
    req.on('close', cleanup)
  }

  return async (req, res, path) => {
    if (path === '/' || path === '/ui') {
      res.writeHead(302, { location: '/ui/' })
      res.end()
      return true
    }
    if (path.startsWith('/ui/')) {
      await serveStatic(res, path)
      return true
    }
    if (path.startsWith('/admin/api/')) {
      await handleAdmin(req, res, path)
      return true
    }
    return false
  }
}
