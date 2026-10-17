/**
 * In-memory flight recorder for everything agents send the server. Nothing
 * here is persisted: it holds the last `capacity` requests plus rolling
 * aggregates, which is what the dashboard's live views are drawn from.
 */

export interface EventClient {
  /** Name of the token that was used (or `env` / `open`). */
  token?: string
  ip?: string
  /** First word of the User-Agent, e.g. `claude-code`. */
  agent?: string
  userAgent?: string
}

export interface BrainEvent {
  id: number
  ts: string
  /** `mcp` and `api` are authorized calls; `auth` is a rejected one. */
  source: 'mcp' | 'api' | 'auth'
  /** JSON-RPC method (`tools/call`) or `GET /api/project`. */
  method: string
  tool?: string
  /** What the client said its project was: an id, or `remote:<host/owner/repo>`. */
  project?: string
  client: EventClient
  durationMs: number
  ok: boolean
  httpStatus: number
  bytesIn: number
  bytesOut: number
  /** Estimated tokens in the text sent back to the agent. */
  tokensOut: number
  /** Short ids (#abc12345) mentioned in the response: the memories this call touched. */
  memoryRefs: string[]
  error?: string
  request?: unknown
  response?: unknown
}

export type EventSummary = Omit<BrainEvent, 'request' | 'response'> & { hasPayload: boolean }

export interface ToolStat {
  name: string
  count: number
  errors: number
  p50Ms: number
  p95Ms: number
  avgTokensOut: number
}

export interface ClientStat {
  key: string
  token?: string
  ip?: string
  agent?: string
  firstSeen: string
  lastSeen: string
  requests: number
  errors: number
  lastTool?: string
  lastProject?: string
  active: boolean
}

export interface ProjectStat {
  project: string
  requests: number
  lastSeen: string
}

export interface MinuteBucket {
  t: string
  requests: number
  errors: number
  tokensOut: number
}

export interface Stats {
  startedAt: string
  uptimeSeconds: number
  totals: { requests: number; errors: number; authFailures: number; tokensOut: number; bytesIn: number; bytesOut: number }
  perMinute: MinuteBucket[]
  tools: ToolStat[]
  clients: ClientStat[]
  projects: ProjectStat[]
  viewers: number
}

export interface EventFilter {
  tool?: string
  project?: string
  client?: string
  ok?: boolean
  source?: string
  /** Only events with an id below this (for paging back). */
  before?: number
  limit?: number
}

const MINUTE = 60_000
const ACTIVE_MS = 5 * MINUTE
const FORGET_MS = 24 * 60 * MINUTE

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!

export class EventLog {
  private ring: BrainEvent[] = []
  private nextId = 1
  private readonly subscribers = new Set<(event: EventSummary) => void>()
  private readonly clients = new Map<string, ClientStat>()
  private readonly projects = new Map<string, ProjectStat>()
  private readonly minutes = new Map<number, MinuteBucket>()
  private readonly totals = { requests: 0, errors: 0, authFailures: 0, tokensOut: 0, bytesIn: 0, bytesOut: 0 }
  viewers = 0

  constructor(
    readonly capacity = 2000,
    private readonly startedAt = new Date(),
    private readonly clock: () => number = Date.now,
  ) {}

  add(input: Omit<BrainEvent, 'id' | 'ts'>): BrainEvent {
    const now = this.clock()
    const event: BrainEvent = { ...input, id: this.nextId++, ts: new Date(now).toISOString() }
    this.ring.push(event)
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity)

    this.totals.requests++
    if (!event.ok) this.totals.errors++
    if (event.source === 'auth') this.totals.authFailures++
    this.totals.tokensOut += event.tokensOut
    this.totals.bytesIn += event.bytesIn
    this.totals.bytesOut += event.bytesOut

    const minute = Math.floor(now / MINUTE) * MINUTE
    const bucket = this.minutes.get(minute) ?? { t: new Date(minute).toISOString(), requests: 0, errors: 0, tokensOut: 0 }
    bucket.requests++
    if (!event.ok) bucket.errors++
    bucket.tokensOut += event.tokensOut
    this.minutes.set(minute, bucket)
    for (const key of this.minutes.keys()) if (key < now - 6 * 60 * MINUTE) this.minutes.delete(key)

    if (event.source !== 'auth') this.track(event, now)

    const summary = summarize(event)
    for (const fn of this.subscribers) {
      try {
        fn(summary)
      } catch {
        // a broken subscriber must not break recording
      }
    }
    return event
  }

  private track(event: BrainEvent, now: number): void {
    const key = `${event.client.token ?? '-'}|${event.client.ip ?? '-'}|${event.client.agent ?? '-'}`
    const c =
      this.clients.get(key) ??
      { key, token: event.client.token, ip: event.client.ip, agent: event.client.agent, firstSeen: event.ts, lastSeen: event.ts, requests: 0, errors: 0, active: false }
    c.requests++
    if (!event.ok) c.errors++
    c.lastSeen = event.ts
    if (event.tool) c.lastTool = event.tool
    if (event.project) c.lastProject = event.project
    this.clients.set(key, c)
    for (const [k, v] of this.clients) if (Date.parse(v.lastSeen) < now - FORGET_MS) this.clients.delete(k)

    if (event.project) {
      const p = this.projects.get(event.project) ?? { project: event.project, requests: 0, lastSeen: event.ts }
      p.requests++
      p.lastSeen = event.ts
      this.projects.set(event.project, p)
    }
  }

  subscribe(fn: (event: EventSummary) => void): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  get(id: number): BrainEvent | undefined {
    return this.ring.find(e => e.id === id)
  }

  recent(filter: EventFilter = {}): EventSummary[] {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
    const out: EventSummary[] = []
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.ring[i]!
      if (filter.before !== undefined && e.id >= filter.before) continue
      if (filter.tool && e.tool !== filter.tool && e.method !== filter.tool) continue
      if (filter.project && e.project !== filter.project) continue
      if (filter.client && e.client.token !== filter.client && e.client.ip !== filter.client && e.client.agent !== filter.client) continue
      if (filter.ok !== undefined && e.ok !== filter.ok) continue
      if (filter.source && e.source !== filter.source) continue
      out.push(summarize(e))
    }
    return out
  }

  stats(): Stats {
    const now = this.clock()
    const perMinute: MinuteBucket[] = []
    const current = Math.floor(now / MINUTE) * MINUTE
    for (let i = 59; i >= 0; i--) {
      const t = current - i * MINUTE
      perMinute.push(this.minutes.get(t) ?? { t: new Date(t).toISOString(), requests: 0, errors: 0, tokensOut: 0 })
    }

    const byTool = new Map<string, BrainEvent[]>()
    for (const e of this.ring) {
      // protocol chatter (initialize, tools/list…) is in the feed but is not a tool
      if (e.source === 'auth' || (e.source === 'mcp' && !e.tool)) continue
      const name = e.tool ?? e.method
      byTool.set(name, [...(byTool.get(name) ?? []), e])
    }
    const tools: ToolStat[] = [...byTool].map(([name, events]) => {
      const durations = events.map(e => e.durationMs).sort((a, b) => a - b)
      return {
        name,
        count: events.length,
        errors: events.filter(e => !e.ok).length,
        p50Ms: Math.round(percentile(durations, 50)),
        p95Ms: Math.round(percentile(durations, 95)),
        avgTokensOut: Math.round(events.reduce((a, e) => a + e.tokensOut, 0) / events.length),
      }
    })
    tools.sort((a, b) => b.count - a.count)

    return {
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.round((now - this.startedAt.getTime()) / 1000),
      totals: { ...this.totals },
      perMinute,
      tools,
      clients: [...this.clients.values()]
        .map(c => ({ ...c, active: now - Date.parse(c.lastSeen) < ACTIVE_MS }))
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
      projects: [...this.projects.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
      viewers: this.viewers,
    }
  }
}

export function summarize(e: BrainEvent): EventSummary {
  const { request, response, ...rest } = e
  return { ...rest, hasPayload: request !== undefined || response !== undefined }
}
