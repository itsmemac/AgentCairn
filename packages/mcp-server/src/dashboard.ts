import { readFile } from 'node:fs/promises'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { extname, join, normalize, sep } from 'node:path'
import {
  AdminError,
  InviteError,
  type Brain,
  type MemoryKind,
  MEMORY_KINDS,
  type Principal,
  ProjectNameError,
  QueryRejectedError,
  accessibleProjectIds,
  acceptInvite,
  authorize,
  changeAdminPassword,
  checkConnection,
  countActiveTokens,
  countActiveUsers,
  countAdmins,
  createApiToken,
  createFirstAdmin,
  createInvite,
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
  listAudit,
  listInvites,
  listMembers,
  listProjects,
  listSessions,
  listUserOverview,
  loadConfig,
  migrateUsers,
  previewInvite,
  principalOf,
  projectRoles,
  recordAudit,
  removeMembership,
  removeUser,
  revokeInvite,
  setMembership,
  setUserLimits,
  setUserRole,
  setUserStatus,
  transferOwnership,
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
  const inviteLookups = new RateLimiter(40, 10 * 60_000)
  const inviteAccepts = new RateLimiter(12, 10 * 60_000)

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
        userId: me?.userId ?? null,
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
        void recordAudit(brain, { actor: admin.username, action: 'setup.completed' })
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
      if (!admin) {
        void recordAudit(brain, { actor: null, action: 'login.failed', target: username.slice(0, 64) })
        throw new HttpError(401, 'bad_credentials', 'Wrong username or password.')
      }
      loginByUser.reset(username)
      void recordAudit(brain, { actor: admin.username, action: 'login' })
      const s = sessions.create(admin.username)
      return send(res, 200, { username: admin.username }, { 'set-cookie': cookieFor(s.id, s.maxAgeSeconds) })
    }

    // ---- invitations: the link is the credential, so these are public and rate limited --------
    const inviteMatch = /^invite\/([^/]+)(\/accept)?$/.exec(route)
    if (inviteMatch) {
      const token = decodeURIComponent(inviteMatch[1]!)
      if (method === 'GET' && !inviteMatch[2]) {
        if (!inviteLookups.attempt(ip)) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in a few minutes.')
        const info = await previewInvite(brain, token)
        if (!info) throw new HttpError(404, 'invite_gone', 'This invitation is not valid: it was used, withdrawn or has expired.')
        return send(res, 200, {
          kind: info.kind,
          role: info.role,
          username: info.username,
          forUsername: info.forUsername,
          grants: info.grants.map(g => ({ projectName: g.projectName, role: g.role })),
          invitedBy: info.createdBy,
          expiresAt: info.expiresAt,
        })
      }
      if (method === 'POST' && inviteMatch[2]) {
        if (!inviteAccepts.attempt(ip)) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in a few minutes.')
        const body = asRecord(await readJson(req, deps.maxBodyBytes))
        try {
          const user = await acceptInvite(brain, token, { username: typeof body.username === 'string' ? body.username : undefined, password: String(body.password ?? '') })
          sessions.destroyUser(user.username)
          auth.invalidate()
          principals.delete(user.username)
          void recordAudit(brain, { actor: user.username, action: 'invite.accepted', target: user.username })
          const s = sessions.create(user.username)
          return send(res, 200, { username: user.username }, { 'set-cookie': cookieFor(s.id, s.maxAgeSeconds) })
        } catch (error) {
          if (error instanceof InviteError) {
            throw new HttpError(error.code === 'gone' ? 410 : error.code === 'taken' ? 409 : 400, error.code === 'gone' ? 'invite_gone' : error.code === 'taken' ? 'username_taken' : 'invalid', error.message)
          }
          throw error
        }
      }
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
      void recordAudit(brain, { actor: session.username, action: 'password.changed' })
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
      const roles = await projectRoles(brain, principal)
      const list = await listProjects(brain, { projectIds: await accessibleProjectIds(brain, principal) })
      return send(res, 200, { projects: list.map(p => ({ ...p, role: roles.get(p.id) ?? (principal.solo ? 'owner' : null) })) })
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
      void recordAudit(brain, { actor: principal.username, action: 'project.created', target: made.name })
      return send(res, 200, { id: made.id, name: made.name, created: true })
    }

    const projectMatch = /^projects\/([^/]+)$/.exec(route)
    if (projectMatch && method === 'GET') {
      await authorize(brain, principal, 'memory.read', decodeURIComponent(projectMatch[1]!))
      const detail = await getProjectDetail(brain, decodeURIComponent(projectMatch[1]!))
      if (!detail) throw new HttpError(404, 'not_found', 'No such project.')
      const role = (await projectRoles(brain, principal)).get(detail.id) ?? (principal.solo ? 'owner' : null)
      return send(res, 200, { ...detail, role })
    }

    if (projectMatch && method === 'DELETE') {
      const id = decodeURIComponent(projectMatch[1]!)
      await authorize(brain, principal, 'project.delete', id)
      const label = (await getProjectDetail(brain, id))?.name ?? id
      const gone = await deleteProject(brain, id)
      if (!gone) throw new HttpError(404, 'not_found', 'No such project.')
      void recordAudit(brain, { actor: principal.username, action: 'project.deleted', target: label, detail: `${gone.memories} memories` })
      return send(res, 200, { id, ...gone })
    }

    const membersMatch = /^projects\/([^/]+)\/members(?:\/([^/]+))?$/.exec(route)
    if (membersMatch) {
      const id = decodeURIComponent(membersMatch[1]!)
      const userId = membersMatch[2] ? decodeURIComponent(membersMatch[2]) : undefined
      const projectName = async () => (await getProjectDetail(brain, id))?.name ?? id
      const usernameOf = async (uid: string) => (await listMembers(brain, id)).find(m => m.userId === uid)?.username ?? uid
      if (method === 'GET' && !userId) {
        await authorize(brain, principal, 'memory.read', id)
        return send(res, 200, { members: await listMembers(brain, id) })
      }
      if (method === 'POST' && !userId) {
        await authorize(brain, principal, 'member.manage', id)
        const body = asRecord(await readJson(req, deps.maxBodyBytes))
        const role = body.role
        if (!isProjectRole(role) || role === 'owner') throw new HttpError(400, 'invalid', 'Role must be viewer, editor or maintainer.')
        const target = await getUserByUsername(brain, String(body.username ?? ''))
        if (!target || target.status !== 'active') throw new HttpError(404, 'no_such_user', 'No such user. Ask an admin to invite them first.')
        await setMembership(brain, id, target.id, role)
        void recordAudit(brain, { actor: principal.username, action: 'member.added', target: await projectName(), detail: `${target.username} as ${role}` })
        return send(res, 200, { members: await listMembers(brain, id) })
      }
      if (method === 'PUT' && userId) {
        await authorize(brain, principal, 'member.manage', id)
        const role = asRecord(await readJson(req, deps.maxBodyBytes)).role
        if (!isProjectRole(role) || role === 'owner') throw new HttpError(400, 'invalid', 'Role must be viewer, editor or maintainer.')
        await setMembership(brain, id, userId, role)
        void recordAudit(brain, { actor: principal.username, action: 'member.changed', target: await projectName(), detail: `${await usernameOf(userId)} is now ${role}` })
        return send(res, 200, { members: await listMembers(brain, id) })
      }
      if (method === 'DELETE' && userId) {
        // you may always leave a project; removing someone else needs member.manage
        const leaving = userId === principal.userId
        if (!leaving) await authorize(brain, principal, 'member.manage', id)
        else await authorize(brain, principal, 'memory.read', id)
        const who = await usernameOf(userId)
        if (!(await removeMembership(brain, id, userId))) throw new HttpError(404, 'not_found', 'That user is not a member.')
        void recordAudit(brain, { actor: principal.username, action: leaving ? 'member.left' : 'member.removed', target: await projectName(), detail: leaving ? undefined : who })
        return send(res, 200, { members: await listMembers(brain, id) })
      }
    }

    const transferMatch = /^projects\/([^/]+)\/transfer$/.exec(route)
    if (transferMatch && method === 'POST') {
      const id = decodeURIComponent(transferMatch[1]!)
      await authorize(brain, principal, 'project.delete', id) // only the owner hands a project over
      const target = await getUserByUsername(brain, String(asRecord(await readJson(req, deps.maxBodyBytes)).username ?? ''))
      if (!target || target.status !== 'active') throw new HttpError(404, 'no_such_user', 'No such user.')
      if (target.id === principal.userId) throw new HttpError(400, 'invalid', 'You already own this project.')
      await transferOwnership(brain, id, target.id)
      void recordAudit(brain, { actor: principal.username, action: 'project.transferred', target: (await getProjectDetail(brain, id))?.name ?? id, detail: `to ${target.username}` })
      return send(res, 200, { members: await listMembers(brain, id) })
    }

    const sessionsMatch = /^projects\/([^/]+)\/sessions$/.exec(route)
    if (sessionsMatch && method === 'GET') {
      const id = decodeURIComponent(sessionsMatch[1]!)
      await authorize(brain, principal, 'memory.read', id)
      return send(res, 200, { sessions: await listSessions(brain, id, { limit: q.get('limit') ? Number(q.get('limit')) : 20 }) })
    }

    if (route === 'users/lookup' && method === 'GET') {
      const found = await getUserByUsername(brain, q.get('username') ?? '')
      if (!found || found.status !== 'active') throw new HttpError(404, 'no_such_user', 'No such user.')
      return send(res, 200, { id: found.id, username: found.username })
    }

    if (route === 'users' && method === 'GET') {
      requireAdmin(principal)
      return send(res, 200, { users: await listUserOverview(brain), invites: await listInvites(brain) })
    }

    const userMatch = /^users\/([^/]+)$/.exec(route)
    if (userMatch && (method === 'PATCH' || method === 'DELETE')) {
      requireAdmin(principal)
      const id = decodeURIComponent(userMatch[1]!)
      const target = (await listUserOverview(brain)).find(u => u.id === id)
      if (!target) throw new HttpError(404, 'not_found', 'No such user.')
      // what they may do is looked up again at once; their sign-ins end only when they are disabled or removed
      const refresh = (endSessions: boolean) => {
        if (endSessions) sessions.destroyUser(target.username)
        principals.delete(target.username)
        auth.invalidate()
      }
      try {
        if (method === 'DELETE') {
          if (id === principal.userId) throw new HttpError(400, 'invalid', 'You cannot remove your own account.')
          await removeUser(brain, id)
          refresh(true)
          void recordAudit(brain, { actor: principal.username, action: 'user.removed', target: target.username })
          return send(res, 200, { ok: true })
        }
        const body = asRecord(await readJson(req, deps.maxBodyBytes))
        if (body.role !== undefined) {
          if (body.role !== 'admin' && body.role !== 'member') throw new HttpError(400, 'invalid', 'Role must be admin or member.')
          if (body.role !== target.role) {
            await setUserRole(brain, id, body.role)
            void recordAudit(brain, { actor: principal.username, action: 'user.role', target: target.username, detail: String(body.role) })
          }
        }
        if (body.status !== undefined) {
          if (body.status !== 'active' && body.status !== 'disabled') throw new HttpError(400, 'invalid', 'Status must be active or disabled.')
          if (body.status === 'disabled' && id === principal.userId) throw new HttpError(400, 'invalid', 'You cannot disable your own account.')
          if (body.status !== target.status) {
            await setUserStatus(brain, id, body.status)
            if (body.status === 'disabled') refresh(true)
            void recordAudit(brain, { actor: principal.username, action: body.status === 'disabled' ? 'user.disabled' : 'user.enabled', target: target.username })
          }
        }
        if (body.maxProjects !== undefined) {
          await setUserLimits(brain, id, { maxProjects: body.maxProjects === null || body.maxProjects === '' ? null : Number(body.maxProjects) })
          void recordAudit(brain, { actor: principal.username, action: 'user.limit', target: target.username, detail: String(body.maxProjects ?? 'none') })
        }
        refresh(false)
        return send(res, 200, { user: (await listUserOverview(brain)).find(u => u.id === id) })
      } catch (error) {
        if (error instanceof AdminError) throw new HttpError(400, 'invalid', error.message)
        throw error
      }
    }

    if (route === 'invites' && method === 'POST') {
      requireAdmin(principal)
      const body = asRecord(await readJson(req, deps.maxBodyBytes))
      try {
        const made = await createInvite(brain, principal, {
          kind: body.kind === 'reset' ? 'reset' : 'join',
          role: body.role === 'admin' ? 'admin' : 'member',
          username: typeof body.username === 'string' ? body.username : undefined,
          forUserId: typeof body.forUserId === 'string' ? body.forUserId : undefined,
          grants: Array.isArray(body.grants) ? (body.grants as { projectId: string; role: 'viewer' | 'editor' | 'maintainer' }[]) : undefined,
          maxProjects: body.maxProjects === undefined || body.maxProjects === null || body.maxProjects === '' ? null : Number(body.maxProjects),
          ttlDays: typeof body.ttlDays === 'number' ? body.ttlDays : undefined,
        })
        void recordAudit(brain, { actor: principal.username, action: 'invite.created', target: made.info.forUsername ?? made.info.username ?? made.info.role, detail: made.info.kind === 'reset' ? 'password reset' : `${made.info.role}, ${made.info.grants.length} project(s)` })
        return send(res, 200, made)
      } catch (error) {
        if (error instanceof InviteError) throw new HttpError(error.code === 'taken' ? 409 : 400, error.code === 'taken' ? 'username_taken' : 'invalid', error.message)
        throw error
      }
    }

    const inviteIdMatch = /^invites\/([0-9a-f-]+)$/.exec(route)
    if (inviteIdMatch && method === 'DELETE') {
      requireAdmin(principal)
      if (!(await revokeInvite(brain, inviteIdMatch[1]!))) throw new HttpError(404, 'not_found', 'No such pending invitation.')
      void recordAudit(brain, { actor: principal.username, action: 'invite.revoked' })
      return send(res, 200, { ok: true })
    }

    if (route === 'audit' && method === 'GET') {
      requireAdmin(principal)
      return send(res, 200, {
        events: await listAudit(brain, {
          limit: q.get('limit') ? Number(q.get('limit')) : 100,
          before: q.get('before') ?? undefined,
          action: q.get('action') ?? undefined,
        }),
      })
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
        sort: q.get('sort') === 'recent' || q.get('sort') === 'oldest' ? (q.get('sort') as 'recent' | 'oldest') : undefined,
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
      void recordAudit(brain, { actor: principal.username, action: 'console.query', detail: String(body.query ?? '').replace(/\s+/g, ' ').slice(0, 200) })
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
        const projects = Array.isArray(body.projects) ? body.projects.filter((p): p is string => typeof p === 'string') : []
        // a token can only be limited to projects its owner can reach
        for (const p of projects) await authorize(brain, principal, 'memory.read', p)
        const created = await createApiToken(brain, String(body.name ?? ''), session.username, { readOnly: body.readOnly === true, projects })
        auth.invalidate()
        void recordAudit(brain, { actor: principal.username, action: 'token.created', target: created.info.name, detail: [created.info.readOnly ? 'read-only' : '', projects.length ? `${projects.length} project(s)` : ''].filter(Boolean).join(', ') || undefined })
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
      void recordAudit(brain, { actor: principal.username, action: 'token.revoked', target: tokenMatch[1]!.slice(0, 8) })
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
