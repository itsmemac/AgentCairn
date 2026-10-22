import { createInterface } from 'node:readline'
import { ClientError, loadClientConfig, type ClientConfig, type ProjectHint } from '../client.js'
import { hintOf, readLocalProject } from '../project.js'
import { runInit } from './init.js'

/** Headers for one forwarded MCP request: the token plus whatever the folder says about itself. */
export function proxyHeaders(config: ClientConfig, hint: ProjectHint): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (config.token) headers.authorization = `Bearer ${config.token}`
  if (hint.projectId) headers['x-cairn-project'] = hint.projectId
  else if (hint.remote) headers['x-cairn-remote'] = hint.remote
  return headers
}

/** The JSON-RPC messages in a response body: plain JSON, or the `data:` events of an SSE stream. */
export function parseMessages(contentType: string, text: string): unknown[] {
  if (!text.trim()) return []
  const payloads = contentType.includes('text/event-stream')
    ? text
        .split(/\r?\n\r?\n/)
        .map(event =>
          event
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n'),
        )
        .filter(Boolean)
    : [text]
  return payloads.flatMap(p => {
    const parsed: unknown = JSON.parse(p)
    return Array.isArray(parsed) ? parsed : [parsed]
  })
}

const errorReply = (id: unknown, message: string) => ({ jsonrpc: '2.0', id, error: { code: -32000, message } })

/**
 * Sends one JSON-RPC message to the server's `/mcp` endpoint and returns what to write back to the
 * client. Requests that fail get a JSON-RPC error with the same id; notifications never do.
 */
export async function forwardMessage(
  line: string,
  config: ClientConfig,
  hint: ProjectHint,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown[]> {
  let id: unknown
  let isRequest = false
  try {
    const message = JSON.parse(line) as { id?: unknown; method?: string }
    id = message.id
    isRequest = message.id !== undefined && typeof message.method === 'string'
  } catch {
    return [errorReply(null, 'Invalid JSON-RPC message.')]
  }

  try {
    const res = await fetchImpl(`${config.url}/mcp`, {
      method: 'POST',
      headers: proxyHeaders(config, hint),
      body: line,
      signal: AbortSignal.timeout(60_000),
    })
    const text = await res.text()
    if (res.status === 401) throw new ClientError('The Agent Cairn server rejected the token. Check CAIRN_TOKEN.', 'unauthorized', 401)
    if (!res.ok && !text.trim()) throw new ClientError(`The Agent Cairn server returned HTTP ${res.status}.`, 'http_error', res.status)
    return parseMessages(res.headers.get('content-type') ?? '', text)
  } catch (error) {
    const reason =
      error instanceof ClientError ? error.message : `Cannot reach the Agent Cairn server at ${config.url} (${(error as Error).message}).`
    return isRequest ? [errorReply(id, reason)] : []
  }
}

/**
 * A tool the proxy answers itself, because only something running on this machine can write the folder's
 * files. It lets an agent set a folder up in the conversation it is already in, without a restart: the
 * memory tools work at once, and the hooks start with the next Claude Code session.
 */
export const INIT_TOOL = {
  name: 'cairn_init',
  title: 'Set this folder up for Agent Cairn',
  description:
    'Link this folder to an Agent Cairn project and install what goes with it: .cairn.json, the Claude Code hooks (briefing at session start, session capture, handoff reminder) and the CLAUDE.md block. Run it once per folder, when cairn_status shows the project is not linked or the person asks for it. The memory tools work straight away; the hooks start the next time Claude Code starts here. With no project it uses the git remote and creates the project, named after the repository.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'A project id or name to link to. Leave out to use the git remote.' },
      create: { type: 'boolean', description: 'Create the project if it does not exist (default true).' },
    },
    additionalProperties: false,
  },
  annotations: { title: 'Set this folder up for Agent Cairn', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
} as const

/** Adds the local tool to a forwarded tools/list reply, once. */
export function addLocalTools(replies: unknown[]): unknown[] {
  return replies.map(reply => {
    const result = (reply as { result?: { tools?: { name?: string }[] } }).result
    if (!Array.isArray(result?.tools) || result.tools.some(t => t.name === INIT_TOOL.name)) return reply
    return { ...(reply as object), result: { ...result, tools: [...result.tools, INIT_TOOL] } }
  })
}

/** Runs `cairn init` for this folder and reports what it did, in the shape of a tool result. */
export async function runLocalInit(
  args: { project?: unknown; create?: unknown },
  cwd: string,
  run: typeof runInit = runInit,
): Promise<{ text: string; isError: boolean }> {
  const lines: string[] = []
  const project = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : undefined
  try {
    await run(project, { create: args.create !== false, forceRemote: false, personal: false, noClaude: false, local: false }, cwd, line => lines.push(line))
    lines.push('', 'The memory tools work now. The hooks (briefing, session capture, handoff reminder) start the next time Claude Code starts in this folder.')
    return { text: lines.join('\n'), isError: false }
  } catch (error) {
    return { text: [...lines, `Could not set this folder up: ${(error as Error).message}`].join('\n'), isError: true }
  }
}

/** One line from the client: answered here when it is for the local tool, forwarded otherwise. */
export async function handleLine(
  line: string,
  state: { config: ClientConfig; hint: ProjectHint; cwd: string },
  deps: { fetch?: typeof fetch; init?: typeof runInit } = {},
): Promise<unknown[]> {
  let message: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | null = null
  try {
    message = JSON.parse(line)
  } catch {
    // forwardMessage reports the malformed message
  }
  if (message?.method === 'tools/call' && message.params?.name === INIT_TOOL.name && message.id !== undefined) {
    const out = await runLocalInit(message.params.arguments ?? {}, state.cwd, deps.init)
    // later requests carry the folder's new link
    state.hint = hintOf(await readLocalProject(state.cwd))
    return [{ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: out.text }], isError: out.isError } }]
  }
  const replies = await forwardMessage(line, state.config, state.hint, deps.fetch)
  return message?.method === 'tools/list' ? addLocalTools(replies) : replies
}

/**
 * `cairn mcp`: a stdio MCP server that forwards to the remote Agent Cairn server, so it installs like any
 * other MCP (`claude mcp add cairn -- npx -y agentcairn mcp`). The project comes from the folder
 * the agent was started in: `.cairn.json`, else the git remote.
 */
export async function runMcpProxy(cwd: string): Promise<void> {
  const config = loadClientConfig(cwd)
  const state = { config, hint: hintOf(await readLocalProject(cwd)), cwd }
  const pending = new Set<Promise<void>>()

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', raw => {
    const line = raw.trim()
    if (!line) return
    const task = handleLine(line, state).then(replies => {
      for (const reply of replies) process.stdout.write(`${JSON.stringify(reply)}\n`)
    })
    pending.add(task)
    void task.finally(() => pending.delete(task))
  })
  await new Promise<void>(resolve => lines.on('close', resolve))
  await Promise.all(pending)
}
