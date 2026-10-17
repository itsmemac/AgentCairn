import {
  MAX_BRIEFING_TOKENS,
  MEMORY_KINDS,
  MemoryValidationError,
  MIN_BRIEFING_TOKENS,
  ProjectMissingError,
  ProjectNotFoundError,
  RemoteConflictError,
  SupersedeError,
  UnresolvedProjectError,
  buildBriefing,
  checkConnection,
  checkStaleness,
  checkpoint,
  countActiveByKind,
  forgetMemory,
  hasDefaultCredentials,
  listAreas,
  loadConfig,
  recall,
  remember,
  schemaVersion,
  shortId,
  type Memory,
  type Staleness,
} from '@agentcairn/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { BrainContext } from './context.js'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

/** Turns any failure into a message the agent can act on; never throws. */
export function describeError(error: unknown): string {
  if (
    error instanceof MemoryValidationError ||
    error instanceof SupersedeError ||
    error instanceof UnresolvedProjectError ||
    error instanceof ProjectNotFoundError ||
    error instanceof ProjectMissingError ||
    error instanceof RemoteConflictError
  ) {
    return error.message
  }
  const e = error as { code?: string; message?: string }
  if (e.code === 'Neo.ClientError.Security.Unauthorized') {
    return 'Neo4j rejected the credentials. Check NEO4J_USER and NEO4J_PASSWORD.'
  }
  if (e.code === 'ServiceUnavailable' || e.code === 'SessionExpired') {
    return `Cannot reach Neo4j at ${loadConfig().uri}. Check that it is running and NEO4J_URI is right.`
  }
  return `Unexpected error: ${e.message ?? String(error)}`
}

const guard =
  <A>(handler: (args: A) => Promise<ToolResult>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return await handler(args)
    } catch (error) {
      return fail(describeError(error))
    }
  }

export function formatMemory(m: Memory, staleness?: Staleness, score?: number | null): string {
  const meta = [m.kind + (m.area ? `/${m.area}` : ''), `importance ${m.importance}`, m.createdAt.slice(0, 10)]
  if (m.status === 'superseded') meta.push('superseded')
  if (score != null) meta.push(`score ${score.toFixed(2)}`)
  const stale =
    staleness?.status === 'stale' ? `\n⚠ may be stale (changed: ${staleness.changedPaths.slice(0, 3).join(', ')})` : ''
  const paths = m.paths.length ? `\npaths: ${m.paths.join(', ')}` : ''
  return `#${shortId(m.id)} [${meta.join(', ')}] ${m.title}\n${m.body}${paths}${stale}`
}

const kindSchema = z.enum(MEMORY_KINDS)
const commitShaSchema = z.string().optional().describe('Set automatically by hooks; leave empty')
const authorSchema = z.string().optional().describe('Set automatically by hooks; leave empty')
const pathsSchema = z.array(z.string()).max(50).optional().describe('Repo-relative files or folders this concerns; used to detect staleness')
const areaSchema = z.string().optional().describe('Module or subsystem this is about')

export const SERVER_INSTRUCTIONS = `Agent Cairn is the shared, persistent memory of this project, written by agents like you.
- Start of a session: call cairn_briefing before exploring the repo and trust it over re-reading files. If it returns an onboarding prompt, follow it.
- After finishing a goal or process: call cairn_checkpoint.
- When you learn something durable (a decision and its reason, a convention, a trap): call cairn_remember. Replace outdated memories with supersedes (ids shown as #abc12345).
- Look things up with cairn_recall instead of searching the repo for context that is probably recorded.`

export function registerTools(server: McpServer, ctx: BrainContext): void {
  server.registerTool(
    'cairn_briefing',
    {
      title: 'Project briefing',
      description:
        'Start here. Returns a compact, token-budgeted briefing of this project (overview, conventions, gotchas, open threads, recent checkpoints, decisions), with stale items flagged. If the project has no memories yet, returns onboarding instructions instead.',
      inputSchema: {
        max_tokens: z
          .number()
          .int()
          .min(MIN_BRIEFING_TOKENS)
          .max(MAX_BRIEFING_TOKENS)
          .optional()
          .describe('Token budget for the briefing (default 1500)'),
      },
    },
    guard(async ({ max_tokens }) => {
      const project = await ctx.project({ write: false })
      const briefing = await buildBriefing(ctx.brain, project.projectId, { maxTokens: max_tokens, cwd: ctx.cwd })
      return ok(briefing.text)
    }),
  )

  server.registerTool(
    'cairn_recall',
    {
      title: 'Search project memory',
      description:
        'Search this project\'s memories by text, kind and area. Without a query, lists the most important and recent ones. Use it for details the briefing left out.',
      inputSchema: {
        query: z.string().optional().describe('Words to search for in titles and bodies'),
        kind: kindSchema.optional(),
        area: areaSchema,
        limit: z.number().int().min(1).max(50).optional().describe('Default 10'),
        include_superseded: z.boolean().optional().describe('Also return memories that were replaced'),
      },
    },
    guard(async ({ query, kind, area, limit, include_superseded }) => {
      const project = await ctx.project({ write: false })
      const found = await recall(ctx.brain, project.projectId, {
        query,
        kind,
        area,
        limit,
        includeSuperseded: include_superseded,
      })
      if (found.length === 0) return ok('No matching memories.')
      const staleness = ctx.cwd ? await checkStaleness(ctx.cwd, found) : undefined
      return ok(found.map(m => formatMemory(m, staleness?.get(m.id), m.score)).join('\n\n'))
    }),
  )

  server.registerTool(
    'cairn_remember',
    {
      title: 'Record a memory',
      description:
        'Store one durable fact about this project: a decision (with its reason), convention, gotcha, overview, open thread or glossary term. One fact per memory. Use supersedes to replace outdated memories.',
      inputSchema: {
        kind: kindSchema,
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(20_000).describe('Short and specific: the why and the non-obvious, no pasted code'),
        area: areaSchema,
        paths: pathsSchema,
        importance: z.number().int().min(1).max(5).optional().describe('1 minor to 5 critical (default 3)'),
        supersedes: z.array(z.string()).max(20).optional().describe('Ids (#abc12345) of memories this replaces'),
        commit_sha: commitShaSchema,
        author: authorSchema,
      },
    },
    guard(async ({ commit_sha, author, ...input }) => {
      const project = await ctx.project({ write: true })
      const m = await remember(ctx.brain, project.projectId, {
        ...input,
        ...(await ctx.provenance({ commitSha: commit_sha, author })),
      })
      const replaced = m.supersedes.length ? ` (replaced ${m.supersedes.map(shortId).map(s => `#${s}`).join(', ')})` : ''
      return ok(`Remembered #${shortId(m.id)}: ${m.title}${replaced}`)
    }),
  )

  server.registerTool(
    'cairn_checkpoint',
    {
      title: 'Checkpoint a finished goal',
      description:
        'Call after finishing a goal or process. Records what was done, stores each decision as its own memory, and keeps what is next as an open thread.',
      inputSchema: {
        goal: z.string().min(1).max(200).describe('What you were doing'),
        outcome: z.string().min(1).max(20_000).describe('What changed and how it ended'),
        decisions: z
          .array(
            z.object({
              title: z.string().min(1).max(200),
              body: z.string().min(1).max(20_000),
              area: areaSchema,
              paths: pathsSchema,
            }),
          )
          .max(20)
          .optional()
          .describe('Choices worth keeping, each with its reason'),
        next: z.string().optional().describe('What remains to be done'),
        resolves: z.array(z.string()).max(20).optional().describe('Ids (#abc12345) of open threads this finished'),
        area: areaSchema,
        paths: pathsSchema,
        commit_sha: commitShaSchema,
        author: authorSchema,
      },
    },
    guard(async ({ commit_sha, author, ...input }) => {
      const project = await ctx.project({ write: true })
      const r = await checkpoint(ctx.brain, project.projectId, {
        ...input,
        ...(await ctx.provenance({ commitSha: commit_sha, author })),
      })
      const parts = [`Checkpoint #${shortId(r.checkpoint.id)} recorded.`]
      if (r.decisions.length) parts.push(`${r.decisions.length} decision(s) stored.`)
      if (r.thread) parts.push(`Open thread #${shortId(r.thread.id)} created.`)
      if (r.checkpoint.supersedes.length) parts.push(`Resolved ${r.checkpoint.supersedes.length} thread(s).`)
      return ok(parts.join(' '))
    }),
  )

  server.registerTool(
    'cairn_areas',
    {
      title: 'List areas',
      description: 'Lists the areas (modules or subsystems) memories have been filed under, with counts.',
      inputSchema: {},
    },
    guard(async () => {
      const project = await ctx.project({ write: false })
      const areas = await listAreas(ctx.brain, project.projectId)
      return ok(areas.length ? areas.map(a => `${a.name}: ${a.count}`).join('\n') : 'No areas yet.')
    }),
  )

  server.registerTool(
    'cairn_forget',
    {
      title: 'Delete a memory',
      description:
        'Permanently deletes one memory by id (#abc12345). Memories it had replaced become active again. Use for memories that were wrong, not for outdated ones: supersede those.',
      inputSchema: { id: z.string().min(6).describe('Memory id or unique prefix, e.g. abc12345') },
    },
    guard(async ({ id }) => {
      const project = await ctx.project({ write: false })
      const gone = await forgetMemory(ctx.brain, project.projectId, id.replace(/^#/, ''))
      if (!gone) return fail(`No memory matches "${id}" in this project.`)
      const restored = gone.restored.length ? ` Restored ${gone.restored.length} earlier memory(ies).` : ''
      return ok(`Deleted #${shortId(gone.id)}: ${gone.title}.${restored}`)
    }),
  )

  server.registerTool(
    'cairn_status',
    {
      title: 'Brain status',
      description: 'Health check: Neo4j connection, which project this folder maps to and how, and memory counts.',
      inputSchema: {},
    },
    guard(async () => {
      const config = loadConfig()
      const info = await checkConnection(ctx.brain)
      await ctx.ready()
      const project = await ctx.project({ write: false })
      const counts = await countActiveByKind(ctx.brain, project.projectId)
      const total = [...counts.values()].reduce((a, b) => a + b, 0)
      const lines = [
        `Neo4j: ${info.agent} at ${config.uri} (schema v${await schemaVersion(ctx.brain)})`,
        `Project: ${project.projectId} (via ${project.source === 'link' ? 'explicit project id' : 'git remote'}${project.isNew ? ', no memories yet' : ''})`,
        `Active memories: ${total}${total ? ` (${[...counts].map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}`,
      ]
      if (ctx.cwd) lines.splice(2, 0, `Folder: ${ctx.cwd}`)
      if (hasDefaultCredentials(config)) lines.push('Warning: Neo4j is using the default credentials.')
      return ok(lines.join('\n'))
    }),
  )
}
