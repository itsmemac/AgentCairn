import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { type ResumeInfo, changedSince, checkStaleness, commitsBetween, getWorkspace, hasCommit } from '@agentcairn/core'
import { ServerClient, loadClientConfig } from '../client.js'
import { hintOf, readLocalProject } from '../project.js'
import { analyzeTurn } from '../transcript.js'
import { buildSnapshot, captureMode } from './capture.js'

/**
 * Claude Code hooks. They must never break a session: every failure ends in
 * silence and exit code 0.
 */

interface HookInput {
  cwd?: string
  transcript_path?: string
  session_id?: string
  /** The person's message, for UserPromptSubmit. */
  prompt?: string
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

function withTimeout<T>(work: Promise<T>, ms = timeoutMs()): Promise<T | undefined> {
  return Promise.race([work, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms).unref())])
}

/** Capture runs on every prompt, so it must never make the person wait: a short limit, then give up quietly. */
const captureTimeoutMs = () => Number(process.env.CAIRN_CAPTURE_TIMEOUT_MS) || 3000

const emit = (value: unknown, out: (s: string) => void) => out(JSON.stringify(value))

export const CHECKPOINT_REASON =
  'You changed files this turn but have not recorded where the work stands. If it is unfinished, call cairn_handoff now (what is done, what is in progress and its exact state, what is next, what is blocked, what you tried and dropped, and anything the person asked that must keep being honoured). If the goal is finished, call cairn_checkpoint instead. Then finish.'

export async function runHook(name: string, out: (s: string) => void = s => process.stdout.write(`${s}\n`)): Promise<void> {
  try {
    const input = await readInput()
    const cwd = input.cwd ?? process.cwd()

    if (name === 'session-start') return await sessionStart(cwd, out)
    if (name === 'stop') return await stop(input, cwd, out)
    if (name === 'pre-tool-use') return await preToolUse(input, cwd, out)
    if (name === 'user-prompt') return await capture(input, cwd, { prompt: input.prompt })
    if (name === 'pre-compact') return await capture(input, cwd, {})
    if (name === 'session-end') return await capture(input, cwd, { ended: true })
  } catch {
    // never disturb the session
  }
}

/**
 * Lines about whether this repository matches where the last work stopped. They are the first thing an
 * agent on a fresh machine needs: is the last commit here, and did the previous session leave work that
 * only exists on a machine that may be gone?
 */
export async function resumeChecks(dir: string, resume: ResumeInfo | null | undefined, here = hostname()): Promise<string[]> {
  if (!resume) return []
  const lines: string[] = []
  const workspace = await getWorkspace(dir)

  if (resume.commitSha) {
    const short = resume.commitSha.slice(0, 7)
    const from = resume.machine ? ` on ${resume.machine}` : ''
    if (!(await hasCommit(dir, resume.commitSha))) {
      lines.push(`The last handoff was written at commit ${short}${from}, and this clone does not have that commit: it may never have been pushed. Ask the person whether that machine can still be reached before assuming that work exists.`)
    } else {
      const ahead = await commitsBetween(dir, resume.commitSha)
      if (ahead) lines.push(`${ahead === 1 ? '1 commit has' : `${ahead} commits have`} been made since the last handoff (${short}).`)
      const moved = await changedSince(dir, resume.commitSha, resume.paths ?? [])
      if (moved.length) lines.push(`${moved.length} of the files the last handoff is about changed since it was written (${moved.slice(0, 5).join(', ')}${moved.length > 5 ? ', …' : ''}): check its "done" claims against them before trusting them.`)
    }
  }
  if (resume.topic && workspace.branch && resume.topic !== workspace.branch.toLowerCase()) {
    lines.push(`The latest handoff is for branch "${resume.topic}", and you are on "${workspace.branch}".`)
  }
  const s = resume.session
  if (s?.dirty.length) {
    const sameMachine = s.machine === here
    const files = `${s.dirty.slice(0, 8).join(', ')}${s.dirty.length > 8 ? ', …' : ''}`
    lines.push(
      sameMachine
        ? `The previous session here left ${s.dirty.length} uncommitted file${s.dirty.length === 1 ? '' : 's'}: ${files}.`
        : `The previous session on ${s.machine ?? 'another machine'} left ${s.dirty.length} uncommitted file${s.dirty.length === 1 ? '' : 's'} (${files}). That work lives only on that machine; if it is gone, the notes above are what remains of it.`,
    )
  }
  return lines
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
  const checks = await resumeChecks(local.dir, briefing.resume).catch(() => [])
  const text = checks.length ? `${briefing.text}\n\n## Check before you continue\n${checks.map(c => `- ${c}`).join('\n')}` : briefing.text
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }, out)
}

/** Records the session as it stands. Quiet and quick: a failure here must never reach the person. */
async function capture(input: HookInput, cwd: string, options: { prompt?: string; ended?: boolean }): Promise<void> {
  const mode = captureMode()
  if (mode === 'off') return
  const local = await readLocalProject(cwd)
  if (!local.projectId && !local.remote) return
  const ms = captureTimeoutMs()
  await withTimeout(
    (async () => {
      const snapshot = await buildSnapshot({
        sessionId: input.session_id,
        transcriptPath: input.transcript_path,
        prompt: options.prompt,
        ended: options.ended,
        dir: local.dir,
        mode,
      })
      if (snapshot) await new ServerClient(loadClientConfig(local.dir), hintOf(local), ms).session(snapshot)
    })().catch(() => undefined),
    ms,
  )
}

async function stop(input: HookInput, cwd: string, out: (s: string) => void): Promise<void> {
  if (!input.transcript_path) return
  await capture(input, cwd, {})
  if (input.stop_hook_active) return
  const minEdits = Number(process.env.CAIRN_CHECKPOINT_MIN_EDITS) || 3
  const turn = analyzeTurn(await readFile(input.transcript_path, 'utf8'))
  if (turn.edits >= minEdits && !turn.checkpointed && !turn.handedOff) emit({ decision: 'block', reason: CHECKPOINT_REASON }, out)
}

async function preToolUse(input: HookInput, cwd: string, out: (s: string) => void): Promise<void> {
  const tool = /cairn_(remember|checkpoint|handoff|resume)$/.exec(input.tool_name ?? '')?.[1]
  if (!tool) return
  const dir = (await readLocalProject(cwd)).dir
  const repo = await withTimeout(getWorkspace(dir))
  if (!repo || (!repo.head && !repo.user && !repo.branch)) return
  // a handoff and a resume carry where the repository stands; a memory carries who wrote it, and at which commit
  const workspace = { ...(repo.branch ? { branch: repo.branch } : {}), ...(repo.head ? { head: repo.head } : {}), dirty: repo.dirty }
  const stamp = {
    ...(tool !== 'resume' && repo.head ? { commit_sha: repo.head } : {}),
    ...(tool !== 'resume' && repo.user ? { author: repo.user } : {}),
    ...(tool === 'handoff' || tool === 'resume' ? { workspace } : {}),
  }
  emit(
    { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input.tool_input, ...stamp } } },
    out,
  )
}
