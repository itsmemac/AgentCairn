import type { Brain } from '@agentcairn/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { BrainContext, type Scope } from './context.js'
import { SERVER_INSTRUCTIONS, registerTools } from './tools.js'
import { SERVER_VERSION } from './version.js'

export const SERVER_NAME = 'cairn'
export { SERVER_VERSION }

/** `scope` may be a folder (stdio mode) or a client-supplied project hint (remote mode). */
export function createBrainServer(
  brain: Brain,
  scope: string | Scope,
  options: { agent?: string; onProject?: (projectId: string) => void } = {},
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  )
  const resolved: Scope = typeof scope === 'string' ? { cwd: scope } : scope
  const ctx = new BrainContext(brain, resolved, () => server.server.getClientVersion()?.name ?? options.agent, options.onProject)
  registerTools(server, ctx)
  return server
}
