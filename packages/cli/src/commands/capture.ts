import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, relative, resolve, sep } from 'node:path'
import { type SessionInput, getWorkspace, sanitize } from '@agentcairn/core'
import { digestSession } from '../transcript.js'

/**
 * How much of a conversation to record. Everything is redacted for secrets before it leaves the machine.
 * - `full` (default): what the person asked, the agent's last message, files, commits, repository state;
 * - `meta`: only files, commits and repository state, never any words;
 * - `off`: nothing.
 */
export type CaptureMode = 'off' | 'meta' | 'full'

export function captureMode(env: NodeJS.ProcessEnv = process.env): CaptureMode {
  const value = env.CAIRN_SESSION_CAPTURE?.trim().toLowerCase()
  return value === 'off' || value === 'meta' ? value : 'full'
}

export interface CaptureSource {
  sessionId?: string
  transcriptPath?: string
  /** A prompt that may not be in the transcript yet (the hook runs before it is written). */
  prompt?: string
  ended?: boolean
  /** The project folder (the repository root). */
  dir: string
  mode: CaptureMode
  now?: Date
}

/** How many of the person's prompts are kept: the first (the goal) and the most recent ones. */
const KEEP_LATEST = 6

const norm = (text: string) => text.replace(/\s+/g, ' ').trim()

/** A snapshot of the session for the server, or null when there is nothing to say or capture is off. */
export async function buildSnapshot(source: CaptureSource): Promise<SessionInput | null> {
  if (source.mode === 'off') return null
  const sessionId = source.sessionId ?? (source.transcriptPath ? basename(source.transcriptPath, '.jsonl') : undefined)
  if (!sessionId) return null

  const digest = source.transcriptPath
    ? digestSession(await readFile(source.transcriptPath, 'utf8').catch(() => ''))
    : digestSession('')
  const prompts = [...digest.prompts]
  const typed = source.prompt ? norm(source.prompt) : ''
  if (typed && norm(prompts.at(-1)?.text ?? '') !== typed) prompts.push({ at: (source.now ?? new Date()).toISOString(), text: typed })

  const workspace = await getWorkspace(source.dir, { since: digest.startedAt ?? undefined })
  const root = resolve(source.dir)
  const touched = digest.touched
    .map(file => resolve(file))
    .filter(file => file.startsWith(root + sep))
    .map(file => relative(root, file).split(sep).join('/'))

  const words = source.mode === 'full'
  const kept = prompts.length > KEEP_LATEST + 1 ? [prompts[0]!, ...prompts.slice(-KEEP_LATEST)] : prompts

  return {
    sessionId,
    machine: hostname(),
    agent: 'claude-code',
    author: workspace.user ?? undefined,
    startedAt: digest.startedAt ?? undefined,
    endedAt: source.ended ? (source.now ?? new Date()).toISOString() : undefined,
    branch: workspace.branch ?? undefined,
    head: workspace.head ?? undefined,
    headSubject: workspace.headSubject ?? undefined,
    dirty: workspace.dirty,
    touched,
    commits: workspace.commits,
    prompts: words ? kept.map(p => ({ at: p.at ?? undefined, text: sanitize(p.text, 800) })) : [],
    lastReply: words && digest.lastReply ? sanitize(digest.lastReply, 3000) : undefined,
    tools: digest.tools,
  }
}
