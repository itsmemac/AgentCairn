import { readFile } from 'node:fs/promises'
import { checkStaleness, getRepoState } from '@agentcairn/core'
import { ServerClient, loadClientConfig } from '../client.js'
import { hintOf, readLocalProject } from '../project.js'
import { analyzeTurn } from '../transcript.js'

/**
 * Claude Code hooks. They must never break a session: every failure ends in
 * silence and exit code 0.
 */

interface HookInput {
  cwd?: string
  transcript_path?: string
  stop_hook_active?: boolean
  tool_name?: string
  tool_input?: Record<string, unknown>
}

async function readInput(): Promise<HookInput> {
  if (process.stdin.isTTY) return {}
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput
  } catch {
    return {}
  }
}

const timeoutMs = () => Number(process.env.CAIRN_HOOK_TIMEOUT_MS) || 10_000

function withTimeout<T>(work: Promise<T>): Promise<T | undefined> {
  return Promise.race([work, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), timeoutMs()).unref())])
}

const emit = (value: unknown, out: (s: string) => void) => out(JSON.stringify(value))

export const CHECKPOINT_REASON =
  'You changed files this turn but have not recorded a checkpoint. Call cairn_checkpoint now (goal, outcome, any decisions with their reasons, and what is next), then finish.'

export async function runHook(name: string, out: (s: string) => void = s => process.stdout.write(`${s}\n`)): Promise<void> {
  try {
    const input = await readInput()
    const cwd = input.cwd ?? process.cwd()

    if (name === 'session-start') return await sessionStart(cwd, out)
    if (name === 'stop') return await stop(input, out)
    if (name === 'pre-tool-use') return await preToolUse(input, cwd, out)
  } catch {
    // never disturb the session
  }
}

async function sessionStart(cwd: string, out: (s: string) => void): Promise<void> {
  const local = await readLocalProject(cwd)
  if (!local.projectId && !local.remote) return
  const client = new ServerClient(loadClientConfig(local.dir), hintOf(local), timeoutMs())

  const briefing = await withTimeout(
    (async () => {
      const inputs = await client.staleInputs()
      const staleness = await checkStaleness(local.dir, inputs)
      const stale = [...staleness].filter(([, s]) => s.status === 'stale').map(([id, s]) => ({ id, changedPaths: s.changedPaths }))
      const maxTokens = Number(process.env.CAIRN_BRIEFING_TOKENS) || 1200
      return client.briefing({ maxTokens, stale })
    })(),
  )
  if (!briefing) return
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: briefing.text } }, out)
}

async function stop(input: HookInput, out: (s: string) => void): Promise<void> {
  if (input.stop_hook_active || !input.transcript_path) return
  const minEdits = Number(process.env.CAIRN_CHECKPOINT_MIN_EDITS) || 3
  const turn = analyzeTurn(await readFile(input.transcript_path, 'utf8'))
  if (turn.edits >= minEdits && !turn.checkpointed) emit({ decision: 'block', reason: CHECKPOINT_REASON }, out)
}

async function preToolUse(input: HookInput, cwd: string, out: (s: string) => void): Promise<void> {
  if (!input.tool_name || !/cairn_(remember|checkpoint)$/.test(input.tool_name)) return
  const repo = await withTimeout(getRepoState((await readLocalProject(cwd)).dir))
  if (!repo || (!repo.head && !repo.user)) return
  emit(
    {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          ...input.tool_input,
          ...(repo.head ? { commit_sha: repo.head } : {}),
          ...(repo.user ? { author: repo.user } : {}),
        },
      },
    },
    out,
  )
}
