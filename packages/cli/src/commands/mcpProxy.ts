import { createInterface } from 'node:readline'
import { ClientError, loadClientConfig, type ClientConfig, type ProjectHint } from '../client.js'
import { hintOf, readLocalProject } from '../project.js'

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
 * `cairn mcp`: a stdio MCP server that forwards to the remote Agent Cairn server, so it installs like any
 * other MCP (`claude mcp add cairn -- npx -y agentcairn mcp`). The project comes from the folder
 * the agent was started in: `.cairn.json`, else the git remote.
 */
export async function runMcpProxy(cwd: string): Promise<void> {
  const config = loadClientConfig(cwd)
  const hint = hintOf(await readLocalProject(cwd))
  const pending = new Set<Promise<void>>()

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', raw => {
    const line = raw.trim()
    if (!line) return
    const task = forwardMessage(line, config, hint).then(replies => {
      for (const reply of replies) process.stdout.write(`${JSON.stringify(reply)}\n`)
    })
    pending.add(task)
    void task.finally(() => pending.delete(task))
  })
  await new Promise<void>(resolve => lines.on('close', resolve))
  await Promise.all(pending)
}
