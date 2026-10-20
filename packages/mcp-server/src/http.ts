import { fileURLToPath } from 'node:url'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import {
  AccessError,
  type Brain,
  MembershipError,
  MemoryValidationError,
  type Principal,
  ProjectMissingError,
  ProjectNameError,
  ProjectNotFoundError,
  RemoteConflictError,
  SOLO_PRINCIPAL,
  SessionError,
  type Staleness,
  UnresolvedProjectError,
  attachRemote,
  buildBriefing,
  buildResume,
  checkConnection,
  countActiveByKind,
  estimateTokens,
  hasDefaultCredentials,
  listSessions,
  listStaleInputs,
  loadConfig,
  normalizeRemoteHint,
  registerProject,
  remoteHash,
  schemaVersion,
  SupersedeError,
  upsertSession,
} from '@agentcairn/core'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Authenticator, authFailureMessage } from './authn.js'
import { BrainContext } from './context.js'
import { createDashboard } from './dashboard.js'
import { type BrainEvent, EventLog } from './events.js'
import { SessionStore, SetupGate } from './security.js'
import { createBrainServer } from './server.js'
import { HttpError, asRecord, clientIp, header, readJson, send } from './util.js'
import { SERVER_VERSION } from './version.js'

export const PROJECT_HEADER = 'x-cairn-project'
export const REMOTE_HEADER = 'x-cairn-remote'

export interface HttpOptions {
  /** Static bearer token (CAIRN_TOKEN). Tokens made in the dashboard work too. */
  token?: string
  /** Run without any authentication. Trusted networks only. */
  noAuth?: boolean
  maxBodyBytes?: number
  log?: (message: string) => void
  /** `full` keeps request and response payloads for the dashboard; `meta` keeps only the summary. */
  capture?: 'full' | 'meta'
  /** How many recent requests the flight recorder holds. */
  eventCapacity?: number
  /** Believe X-Forwarded-For (only behind a proxy you control). */
  trustProxy?: boolean
  /** Mark session cookies Secure (when served over HTTPS). */
  secureCookies?: boolean
  /** Serve the dashboard (default true). */
  dashboard?: boolean
  port?: number
}

export interface BrainHttp {
  server: Server
  events: EventLog
  setup: SetupGate
  sessions: SessionStore
  auth: Authenticator
}

const PAYLOAD_LIMIT = 16_384
const CAPTURE_PARSE_LIMIT = 512 * 1024

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof ProjectNotFoundError) return new HttpError(404, 'project_not_found', error.message, { projectId: error.projectId })
  if (error instanceof ProjectMissingError) return new HttpError(404, 'project_not_found', error.message, { projectId: error.projectId })
  if (error instanceof RemoteConflictError) {
    return new HttpError(409, 'remote_conflict', error.message, { ownerProjectId: error.ownerProjectId })
  }
  if (error instanceof UnresolvedProjectError) return new HttpError(400, 'unresolved_project', error.message)
  if (error instanceof AccessError) {
    return error.code === 'not_found'
      ? new HttpError(404, 'project_not_found', error.message, { projectId: error.projectId })
      : new HttpError(403, 'forbidden', error.message, { projectId: error.projectId, action: error.action })
  }
  if (error instanceof MembershipError) {
    return new HttpError(error.code === 'no_such_user' ? 404 : 400, error.code === 'owner' ? 'owner' : error.code === 'no_such_user' ? 'no_such_user' : 'invalid', error.message)
  }
  if (error instanceof ProjectNameError) {
    if (error.code === 'limit') return new HttpError(403, 'project_limit', error.message)
    return new HttpError(error.code === 'exists' ? 409 : 400, error.code === 'ambiguous' ? 'ambiguous_project' : error.code === 'exists' ? 'project_exists' : 'invalid', error.message)
  }
  if (error instanceof MemoryValidationError || error instanceof SupersedeError || error instanceof SessionError) {
    return new HttpError(400, 'invalid', error.message)
  }
  const e = error as { code?: string; message?: string }
  if (e.code === 'ServiceUnavailable' || e.code === 'SessionExpired' || e.code === 'Neo.ClientError.Security.Unauthorized') {
    return new HttpError(503, 'database_unavailable', 'The server cannot reach Neo4j.')
  }
  if (e.message?.startsWith('Invalid project id')) return new HttpError(400, 'invalid', e.message)
  return new HttpError(500, 'internal', 'Unexpected server error.')
}

/** Keeps payloads small enough to hold thousands of them in memory. */
function trimPayload(value: unknown): unknown {
  if (value === undefined) return undefined
  const text = JSON.stringify(value)
  if (text === undefined || text.length <= PAYLOAD_LIMIT) return value
  return { _truncated: true, originalChars: text.length, preview: text.slice(0, PAYLOAD_LIMIT) }
}

/** Records the response as it is written, without changing it. */
function tapResponse(res: ServerResponse): { bytes: () => number; text: () => string | undefined } {
  const chunks: Buffer[] = []
  let kept = 0
  let total = 0
  const take = (chunk: unknown) => {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return
    const buf = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk))
    total += buf.length
    if (kept + buf.length <= CAPTURE_PARSE_LIMIT) {
      chunks.push(buf)
      kept += buf.length
    }
  }
  const write = res.write.bind(res) as (...a: unknown[]) => boolean
  const end = res.end.bind(res) as (...a: unknown[]) => ServerResponse
  ;(res as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
    take(chunk)
    return write(chunk, ...rest)
  }
  ;(res as unknown as { end: unknown }).end = (chunk?: unknown, ...rest: unknown[]) => {
    take(chunk)
    return end(chunk, ...rest)
  }
  return { bytes: () => total, text: () => (total === kept ? Buffer.concat(chunks).toString('utf8') : undefined) }
}

/** A response body is plain JSON, or SSE framing (`event: message` / `data: {...}`) around it. */
function parseResponse(raw: string | undefined): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue
      try {
        return JSON.parse(line.slice(5).trim())
      } catch {
        // keep looking
      }
    }
    return undefined
  }
}

const textOf = (content: unknown): string | undefined =>
  Array.isArray(content)
    ? content.map(c => (c as { text?: unknown }).text).filter((t): t is string => typeof t === 'string').join('\n')
    : undefined

/** Optional protocol probes newer clients send first. "Method not found" is the expected answer, and they fall back, so it is not an error. */
const OPTIONAL_PROBES = new Set(['server/discover'])
const METHOD_NOT_FOUND = -32601

const SHORT_ID = /#([0-9a-f]{8})\b/g
const refsIn = (text: string | undefined): string[] => [...new Set([...(text ?? '').matchAll(SHORT_ID)].map(m => m[1]!))].slice(0, 60)

export function createBrainHttp(brain: Brain, options: HttpOptions = {}): BrainHttp {
  const maxBody = options.maxBodyBytes ?? 1_000_000
  const log = options.log ?? (() => undefined)
  const capture = options.capture ?? 'full'
  const trustProxy = options.trustProxy ?? false
  const events = new EventLog(options.eventCapacity ?? 2000)
  const sessions = new SessionStore()
  const setup = new SetupGate()
  const auth = new Authenticator(brain, { envToken: options.token, noAuth: options.noAuth }, Date.now, log)
  const dashboard =
    options.dashboard === false
      ? undefined
      : createDashboard({
          brain,
          events,
          auth,
          sessions,
          setup,
          version: SERVER_VERSION,
          port: options.port ?? 8787,
          uiDir: fileURLToPath(new URL('../ui', import.meta.url)),
          trustProxy,
          secureCookies: options.secureCookies ?? false,
          maxBodyBytes: maxBody,
          capture,
          authMode: { envToken: Boolean(options.token), noAuth: Boolean(options.noAuth) },
          log,
        })

  const hintOf = (req: IncomingMessage) => ({ projectId: header(req, PROJECT_HEADER), remote: header(req, REMOTE_HEADER) })
  const agentOf = (req: IncomingMessage) => header(req, 'user-agent')?.split(/[\s/]/)[0]
  /** The project each in-flight request resolved to, read when its event is recorded. */
  const resolved = new WeakMap<IncomingMessage, string>()
  /** Who each authenticated request acts as. */
  const principals = new WeakMap<IncomingMessage, Principal>()
  const principalOf = (req: IncomingMessage): Principal => principals.get(req) ?? SOLO_PRINCIPAL
  const contextFor = (req: IncomingMessage) =>
    new BrainContext(brain, { hint: hintOf(req) }, () => agentOf(req), id => resolved.set(req, id), principalOf(req))

  async function handleMcp(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      return send(res, 405, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST.' },
        id: null,
      })
    }
    const server = createBrainServer(brain, { hint: hintOf(req) }, { agent: agentOf(req), onProject: id => resolved.set(req, id), principal: principalOf(req) })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, rawBody: unknown): Promise<void> {
    const ctx = contextFor(req)
    const method = req.method ?? 'GET'
    const body = asRecord(rawBody)

    if (path === '/api/project' && method === 'GET') {
      await ctx.ready()
      const project = await ctx.project({ write: false })
      const counts = await countActiveByKind(brain, project.projectId)
      const info = await checkConnection(brain)
      return send(res, 200, {
        ...project,
        // a project that does not exist (or is not yours to see) is reported by what was asked for
        projectId: project.isNew ? (project.requested ?? project.suggestedName ?? project.projectId) : project.projectId,
        counts: Object.fromEntries(counts),
        total: [...counts.values()].reduce((a, b) => a + b, 0),
        schemaVersion: await schemaVersion(brain),
        neo4j: info.agent,
        defaultCredentials: hasDefaultCredentials(loadConfig()),
      })
    }

    if (path === '/api/init' && method === 'POST') {
      await ctx.ready()
      const remote = typeof body.remote === 'string' ? normalizeRemoteHint(body.remote) : null
      if (typeof body.remote === 'string' && !remote) throw new HttpError(400, 'invalid', 'remote is not a usable git remote.')
      const result = await registerProject(
        brain,
        { projectId: typeof body.projectId === 'string' ? body.projectId : undefined, remoteHash: remote ? remoteHash(remote) : null, remote },
        { allowCreate: body.allowCreate === true, forceRemote: body.forceRemote === true },
        principalOf(req),
      )
      return send(res, 200, result)
    }

    if (path === '/api/stale-inputs' && method === 'GET') {
      const project = await ctx.project({ write: false })
      return send(res, 200, { inputs: await listStaleInputs(brain, project.projectId) })
    }

    if (path === '/api/briefing' && method === 'POST') {
      const project = await ctx.project({ write: false })
      const staleness = new Map<string, Staleness>()
      for (const item of Array.isArray(body.stale) ? body.stale : []) {
        const s = asRecord(item)
        if (typeof s.id === 'string') {
          const changed = Array.isArray(s.changedPaths) ? s.changedPaths.filter((p): p is string => typeof p === 'string') : []
          staleness.set(s.id, { status: 'stale', changedPaths: changed })
        }
      }
      const maxTokens = typeof body.maxTokens === 'number' ? body.maxTokens : undefined
      return send(res, 200, await buildBriefing(brain, project.projectId, { maxTokens, staleness, label: project.isNew ? (project.requested ?? project.suggestedName) : undefined }))
    }

    // Session capture records a conversation as it goes. It never creates a project: a folder nobody
    // registered is simply not recorded.
    if (path === '/api/session' && method === 'POST') {
      const project = await ctx.project({ write: false, action: 'memory.write' })
      if (project.isNew) throw new HttpError(404, 'project_not_found', 'This folder is not linked to a project yet, so the session was not recorded. Run `cairn init`.', { projectId: project.requested ?? project.projectId })
      const saved = await upsertSession(brain, project.projectId, { ...body, sessionId: String(body.sessionId ?? '') })
      return send(res, 200, { id: saved.id, updatedAt: saved.updatedAt })
    }

    if (path === '/api/sessions' && method === 'GET') {
      const project = await ctx.project({ write: false })
      const limit = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit')) || 10
      return send(res, 200, { sessions: project.isNew ? [] : await listSessions(brain, project.projectId, { limit }) })
    }

    if (path === '/api/resume' && method === 'POST') {
      const project = await ctx.project({ write: false })
      const here = asRecord(body.workspace)
      const text = await buildResume(brain, project.projectId, {
        label: project.isNew ? (project.requested ?? project.suggestedName) : undefined,
        here: { branch: typeof here.branch === 'string' ? here.branch : undefined, head: typeof here.head === 'string' ? here.head : undefined, dirty: Array.isArray(here.dirty) ? here.dirty.filter((d): d is string => typeof d === 'string') : undefined },
      })
      return send(res, 200, { text })
    }

    if (path === '/api/remote' && method === 'POST') {
      const remote = typeof body.remote === 'string' ? normalizeRemoteHint(body.remote) : null
      if (!remote) throw new HttpError(400, 'invalid', 'remote is not a usable git remote.')
      const project = await ctx.project({ write: false, action: 'project.update' })
      if (project.isNew) throw new ProjectNotFoundError(project.requested ?? project.projectId)
      await attachRemote(brain, project.projectId, remoteHash(remote), { force: body.force === true, principal: principalOf(req) })
      return send(res, 200, { projectId: project.projectId, remote })
    }

    throw new HttpError(404, 'not_found', `No such endpoint: ${method} ${path}`)
  }

  /** Builds the dashboard's record of one finished request. */
  function record(
    req: IncomingMessage,
    res: ServerResponse,
    source: 'mcp' | 'api',
    path: string,
    body: unknown,
    tap: ReturnType<typeof tapResponse>,
    startedAt: number,
    tokenName: string | undefined,
  ): void {
    const rawResponse = tap.text()
    const parsed = parseResponse(rawResponse)

    let method = `${req.method} ${path}`
    let tool: string | undefined
    let ok = res.statusCode < 400
    let error: string | undefined
    let responseText: string | undefined
    let request: unknown = body
    let response: unknown = parsed

    if (source === 'mcp') {
      const rpc = asRecord(Array.isArray(body) ? body[0] : body)
      const out = asRecord(Array.isArray(parsed) ? parsed[0] : parsed)
      const params = asRecord(rpc.params)
      method = typeof rpc.method === 'string' ? rpc.method : 'mcp'
      if (method === 'tools/call' && typeof params.name === 'string') tool = params.name
      const result = asRecord(out.result)
      const failure = asRecord(out.error)
      responseText = textOf(result.content)
      // an optional probe answered "method not found" is the expected outcome: kept in the feed, not counted as a failure
      const probe = failure.code === METHOD_NOT_FOUND && OPTIONAL_PROBES.has(method)
      if (probe) {
        // nothing to flag
      } else if (typeof failure.message === 'string') {
        ok = false
        error = failure.message
      } else if (result.isError === true) {
        ok = false
        error = responseText
      }
      request = tool ? { tool, arguments: params.arguments } : rpc
      response = tool ? { text: responseText, isError: result.isError === true } : result
      if (probe) response = { note: 'Not supported here; the client falls back to the standard handshake.' }
    } else {
      const out = asRecord(parsed)
      responseText = typeof out.text === 'string' ? out.text : undefined
      if (!ok) error = typeof out.message === 'string' ? out.message : undefined
    }

    const project =
      resolved.get(req) ?? header(req, PROJECT_HEADER) ?? (header(req, REMOTE_HEADER) ? `remote:${header(req, REMOTE_HEADER)}` : undefined)
    const bytesOut = tap.bytes()
    const event: Omit<BrainEvent, 'id' | 'ts'> = {
      source,
      method,
      tool,
      project,
      client: { token: tokenName, ip: clientIp(req, trustProxy), agent: agentOf(req), userAgent: header(req, 'user-agent') },
      durationMs: Math.round(performance.now() - startedAt),
      ok,
      httpStatus: res.statusCode,
      bytesIn: Number(header(req, 'content-length')) || 0,
      bytesOut,
      tokensOut: estimateTokens(responseText ?? rawResponse ?? ''),
      memoryRefs: refsIn(responseText ?? rawResponse),
      error: error?.slice(0, 500),
      request: capture === 'full' ? trimPayload(request) : undefined,
      response: capture === 'full' ? trimPayload(response) : undefined,
    }
    events.add(event)
  }

  const server = createServer((req, res) => {
    void (async () => {
      const startedAt = performance.now()
      let recorded = false
      try {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname

        if (path === '/healthz') {
          try {
            await Promise.race([
              brain.driver.verifyConnectivity(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
            ])
            return send(res, 200, { status: 'ok' })
          } catch {
            return send(res, 503, { status: 'database_unavailable' })
          }
        }

        if (dashboard && (await dashboard(req, res, path))) return

        const isMcp = path === '/mcp'
        if (!isMcp && !path.startsWith('/api/')) throw new HttpError(404, 'not_found', 'Not found.')

        const authResult = await auth.check(req)
        if (!authResult.ok) {
          const message = authFailureMessage(authResult.reason)
          res.setHeader('www-authenticate', 'Bearer')
          send(res, 401, { error: authResult.reason === 'no_tokens' ? 'no_tokens' : 'unauthorized', message })
          events.add({
            source: 'auth',
            method: `${req.method} ${path}`,
            client: { ip: clientIp(req, trustProxy), agent: agentOf(req), userAgent: header(req, 'user-agent') },
            durationMs: Math.round(performance.now() - startedAt),
            ok: false,
            httpStatus: 401,
            bytesIn: 0,
            bytesOut: 0,
            tokensOut: 0,
            memoryRefs: [],
            error: message,
          })
          return
        }

        principals.set(req, authResult.principal)
        const tap = tapResponse(res)
        let body: unknown
        res.on('finish', () => {
          if (recorded) return
          recorded = true
          // a client probing GET/DELETE /mcp for a stream is protocol chatter, not a request
          if (isMcp && req.method !== 'POST') return
          try {
            record(req, res, isMcp ? 'mcp' : 'api', path, body, tap, startedAt, authResult.name)
          } catch (error) {
            log(`could not record event: ${(error as Error).message}`)
          }
        })
        if (req.method === 'POST') body = await readJson(req, maxBody)
        if (isMcp) await handleMcp(req, res, body)
        else await handleApi(req, res, path, body)
      } catch (error) {
        const e = toHttpError(error)
        if (e.status >= 500) log(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
        if (!res.headersSent) send(res, e.status, { error: e.code, message: e.message, ...e.extra })
        else res.end()
      }
    })()
  })

  return { server, events, setup, sessions, auth }
}

export function createHttpServer(brain: Brain, options: HttpOptions = {}): Server {
  return createBrainHttp(brain, options).server
}
