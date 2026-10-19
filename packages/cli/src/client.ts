import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type ResumeInfo, type SessionInput, loadEnvironment } from '@agentcairn/core'

export class ClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ClientError'
  }
}

export interface ClientConfig {
  url: string
  token: string | undefined
}

/**
 * The address and token Claude Code was given when the server was registered
 * (`claude mcp add cairn --scope user -e CAIRN_URL=... -e CAIRN_TOKEN=...`), so `cairn init` and the hooks
 * work right after that one command without exporting anything.
 */
export function claudeRegistration(claudeJson: string = join(homedir(), '.claude.json')): { url?: string; token?: string } {
  try {
    const registered = (JSON.parse(readFileSync(claudeJson, 'utf8')) as { mcpServers?: Record<string, { env?: Record<string, unknown> }> })
      .mcpServers?.cairn?.env
    const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
    return { url: text(registered?.CAIRN_URL), token: text(registered?.CAIRN_TOKEN) }
  } catch {
    return {}
  }
}

/**
 * Reads CAIRN_URL and CAIRN_TOKEN from the environment, then the first env file found, then the
 * server registration in Claude Code's user config.
 */
export function loadClientConfig(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  claudeJson?: string,
): ClientConfig {
  loadEnvironment(cwd, env)
  const registered = env.CAIRN_URL?.trim() ? {} : claudeRegistration(claudeJson)
  const url = (env.CAIRN_URL ?? registered.url)?.trim().replace(/\/+$/, '')
  if (!url) {
    throw new ClientError(
      'CAIRN_URL is not set. Set it to your Agent Cairn server, e.g. http://localhost:8787 (environment variable, ~/.cairn/.env, or register the server with `claude mcp add cairn --scope user -e CAIRN_URL=... -e CAIRN_TOKEN=... -- npx -y agentcairn mcp`).',
      'no_url',
    )
  }
  return { url, token: env.CAIRN_TOKEN || registered.token || undefined }
}

export interface ProjectHint {
  projectId?: string
  remote?: string
}

export interface BriefingReply {
  projectId: string
  status: 'ready' | 'empty'
  text: string
  tokens: number
  includedIds: string[]
  staleIds: string[]
  omitted: number
  /** Where the last work stopped, so a hook can check this repository against it. */
  resume?: ResumeInfo | null
}

export interface ProjectInfo {
  projectId: string
  source: 'link' | 'remote'
  isNew: boolean
  remoteHash: string | null
  counts: Record<string, number>
  total: number
  schemaVersion: number | null
  neo4j: string
  defaultCredentials: boolean
}

export interface InitReply {
  projectId: string
  name?: string
  created: boolean
  remoteAttached: boolean
}

export interface StaleInput {
  id: string
  commitSha: string
  paths: string[]
}

/** Talks to the Agent Cairn server's plain-JSON API. */
export class ServerClient {
  constructor(
    readonly config: ClientConfig,
    readonly hint: ProjectHint = {},
    private readonly timeoutMs = 15_000,
  ) {}

  private async request<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = {}
    if (init.auth !== false && this.config.token) headers.authorization = `Bearer ${this.config.token}`
    if (this.hint.projectId) headers['x-cairn-project'] = this.hint.projectId
    if (this.hint.remote) headers['x-cairn-remote'] = this.hint.remote
    if (init.body !== undefined) headers['content-type'] = 'application/json'

    let res: Response
    try {
      res = await fetch(`${this.config.url}${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new ClientError(`Cannot reach the Agent Cairn server at ${this.config.url} (${(error as Error).message}).`, 'unreachable')
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const message =
        res.status === 401
          ? 'The server rejected the token. Check CAIRN_TOKEN.'
          : ((body.message as string | undefined) ?? `Server returned HTTP ${res.status}.`)
      throw new ClientError(message, (body.error as string | undefined) ?? 'http_error', res.status, body)
    }
    return body as T
  }

  health = () => this.request<{ status: string }>('/healthz', { auth: false })
  project = () => this.request<ProjectInfo>('/api/project')
  init = (body: { projectId?: string; remote?: string; allowCreate?: boolean; forceRemote?: boolean }) =>
    this.request<InitReply>('/api/init', { body })
  staleInputs = async () => (await this.request<{ inputs: StaleInput[] }>('/api/stale-inputs')).inputs
  briefing = (body: { maxTokens?: number; stale?: { id: string; changedPaths: string[] }[] }) =>
    this.request<BriefingReply>('/api/briefing', { body })
  /** Records a snapshot of the running session (never creates a project). */
  session = (body: SessionInput) => this.request<{ id: string; updatedAt: string }>('/api/session', { body })
  /** The full picture for carrying on someone else's work. */
  resume = (body: { workspace?: { branch?: string; head?: string; dirty?: string[] } } = {}) => this.request<{ text: string }>('/api/resume', { body })
  addRemote = (remote: string, force = false) =>
    this.request<{ projectId: string; remote: string }>('/api/remote', { body: { remote, force } })
}
