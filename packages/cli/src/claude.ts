/**
 * Pure helpers that merge Agent Cairn into Claude Code's project files:
 * `.mcp.json`, `.claude/settings.json` (hooks) and `CLAUDE.md`. Existing
 * content is preserved, and running them again changes nothing.
 */

export const MCP_NAME = 'cairn'
export const MD_START = '<!-- cairn:start -->'
export const MD_END = '<!-- cairn:end -->'
const WRITE_TOOLS_MATCHER = `mcp__${MCP_NAME}__cairn_remember|mcp__${MCP_NAME}__cairn_checkpoint`

export class ConfigFileError extends Error {
  constructor(file: string, detail: string) {
    super(`${file} ${detail}. Fix it by hand, or move it aside, and run again.`)
    this.name = 'ConfigFileError'
  }
}

type Json = Record<string, unknown>

function parseObject(text: string | null, file: string): Json {
  if (text === null || text.trim() === '') return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ConfigFileError(file, 'is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigFileError(file, 'is not a JSON object')
  return value as Json
}

const asObject = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const stringify = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`

// ---- .mcp.json -------------------------------------------------------------

export interface McpIdentity {
  projectId?: string
  /** Normalized remote, used when no project id is set. */
  remote?: string
}

/** The server entry: URL and token come from the environment, so no secret or address is committed. */
export function mcpEntry(identity: McpIdentity): Json {
  const headers: Record<string, string> = { Authorization: 'Bearer ${CAIRN_TOKEN}' }
  if (identity.projectId) headers['X-Cairn-Project'] = identity.projectId
  else if (identity.remote) headers['X-Cairn-Remote'] = identity.remote
  else throw new Error('Need a project id or a git remote to identify the project.')
  return { type: 'http', url: '${CAIRN_URL}/mcp', headers }
}

export function mergeMcpConfig(existing: string | null, identity: McpIdentity): string {
  const json = parseObject(existing, '.mcp.json')
  json.mcpServers = { ...asObject(json.mcpServers), [MCP_NAME]: mcpEntry(identity) }
  return stringify(json)
}

export interface McpInspection {
  present: boolean
  projectId?: string
  remote?: string
}

export function inspectMcpConfig(existing: string | null): McpInspection {
  try {
    const entry = asObject(asObject(parseObject(existing, '.mcp.json').mcpServers)[MCP_NAME])
    if (Object.keys(entry).length === 0) return { present: false }
    const headers = asObject(entry.headers)
    return {
      present: true,
      projectId: typeof headers['X-Cairn-Project'] === 'string' ? headers['X-Cairn-Project'] : undefined,
      remote: typeof headers['X-Cairn-Remote'] === 'string' ? headers['X-Cairn-Remote'] : undefined,
    }
  } catch {
    return { present: false }
  }
}

// ---- hooks -----------------------------------------------------------------

const HOOKS = [
  { event: 'SessionStart', name: 'session-start', timeout: 20 },
  { event: 'Stop', name: 'stop', timeout: 10 },
  { event: 'PreToolUse', name: 'pre-tool-use', timeout: 10, matcher: WRITE_TOOLS_MATCHER },
] as const

const isOurs = (command: unknown) =>
  typeof command === 'string' && /cairn|bin.js/i.test(command) && / hook (session-start|stop|pre-tool-use)$/.test(command)

/** Adds (or refreshes) Agent Cairn's three hooks without touching anyone else's. */
export function mergeHooks(existing: string | null, cli: string): string {
  const json = parseObject(existing, 'settings file')
  const hooks = { ...asObject(json.hooks) }

  for (const { event, name, timeout, ...rest } of HOOKS) {
    const matcher = 'matcher' in rest ? rest.matcher : undefined
    const groups = (Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [])
      .map(group => {
        const g = asObject(group)
        const kept = (Array.isArray(g.hooks) ? g.hooks : []).filter(h => !isOurs(asObject(h).command))
        return { ...g, hooks: kept }
      })
      .filter(g => g.hooks.length > 0)
    groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: `${cli} hook ${name}`, timeout }] })
    hooks[event] = groups
  }
  json.hooks = hooks
  return stringify(json)
}

export interface HooksInspection {
  sessionStart: boolean
  stop: boolean
  preToolUse: boolean
}

export function inspectHooks(...files: (string | null)[]): HooksInspection {
  const found = { sessionStart: false, stop: false, preToolUse: false }
  const has = (hooks: Json, event: string, name: string) =>
    (Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []).some(g =>
      (Array.isArray(asObject(g).hooks) ? (asObject(g).hooks as unknown[]) : []).some(h => {
        const c = asObject(h).command
        return isOurs(c) && (c as string).endsWith(` hook ${name}`)
      }),
    )
  for (const file of files) {
    try {
      const hooks = asObject(parseObject(file, 'settings file').hooks)
      found.sessionStart ||= has(hooks, 'SessionStart', 'session-start')
      found.stop ||= has(hooks, 'Stop', 'stop')
      found.preToolUse ||= has(hooks, 'PreToolUse', 'pre-tool-use')
    } catch {
      // unreadable: counts as not installed
    }
  }
  return found
}

// ---- /cairn slash command --------------------------------------------------

export const COMMAND_PATH = ['.claude', 'commands', 'cairn.md'] as const
export const COMMAND_MARKER = '<!-- generated by cairn: safe to overwrite -->'

/**
 * A Claude Code slash command, so `/cairn init my-project`, `/cairn doctor` and friends run the
 * CLI from inside a session. `cli` is how the CLI is invoked (see runner.ts).
 */
export function cairnCommandFile(cli: string): string {
  const tool = cli.startsWith('npx') ? 'npx' : 'node'
  return `---
description: Run the Agent Cairn CLI (init, doctor, briefing, remote) in this project
argument-hint: init <project-id> | doctor | briefing | remote <git-url>
allowed-tools: Bash(${tool}:*)
---
${COMMAND_MARKER}
The Agent Cairn CLI ran in this project folder:

!\`${cli} $ARGUMENTS\`

Show the output above unchanged. If it reports a problem, explain it in a sentence or two and give the one next step. Do not edit any files yourself.
`
}

/** A command file we wrote may be refreshed; one the person wrote themselves is left alone. */
export const mayWriteCommand = (existing: string | null) => existing === null || existing.includes(COMMAND_MARKER)

// ---- CLAUDE.md -------------------------------------------------------------

export function claudeMdBlock(): string {
  return `${MD_START}
## Agent Cairn

This project keeps shared memory in Agent Cairn (the \`cairn\` MCP server).

- Start of a session: use \`cairn_briefing\` before exploring the repo (a hook may already have injected it) and trust it over re-reading files.
- After finishing a goal or process: call \`cairn_checkpoint\`.
- Durable lessons (a decision and why, a convention, a trap): call \`cairn_remember\`; replace outdated ones with \`supersedes\`.
- Look things up with \`cairn_recall\` instead of searching the repo for recorded context.
${MD_END}`
}

export function upsertClaudeMd(existing: string | null): string {
  const block = claudeMdBlock()
  if (existing === null || existing.trim() === '') return `${block}\n`
  const start = existing.indexOf(MD_START)
  const end = existing.indexOf(MD_END)
  if (start !== -1 && end > start) {
    return `${existing.slice(0, start)}${block}${existing.slice(end + MD_END.length)}`
  }
  return `${existing.replace(/\s*$/, '')}\n\n${block}\n`
}

export const hasClaudeMdBlock = (text: string | null) =>
  text !== null && text.includes(MD_START) && text.includes(MD_END)
